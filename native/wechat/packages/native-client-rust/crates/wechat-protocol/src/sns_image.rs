//! Single-request photo upload for a staged Moments publication. Publication is
//! a separate operation; this module never posts a timeline object or retries.
use super::{
    adler32_zero, integer, pack_cdn, put, shared, unpack_cdn, CdnClient, CdnConfig, CdnFields,
};
use crate::crypto::{md5, random, sha256};
use crate::{protobuf as p, AccountState};
use anyhow::{ensure, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use image::GenericImageView;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::{Duration, Instant};

pub const MAX_SNS_IMAGE_BYTES: usize = 1024 * 1024;
const MAX_SNS_IMAGE_EDGE: u32 = 1600;
const SNS_PHOTO_FILETYPE: u32 = 20201;
const SNS_NATIVE_COMMAND: u16 = 10002;
const SNS_NATIVE_HEADER_BYTES: usize = 25;
const MAX_SNS_RECEIPT_BYTES: usize = 64 * 1024;
const MAX_SNS_RECEIPT_FRAMES: usize = 128;

/// SNS photo uploads use the native CDN frame. The file value follows all
/// metadata, matching the native stream sender's separate data phase.
fn sns_native_frame(fields: &CdnFields, uin: u64) -> Result<Vec<u8>> {
    let uin = u32::try_from(uin)?;
    ensure!(uin != 0, "sns_native_invalid_uin");
    let file = fields
        .get("filedata")
        .ok_or_else(|| anyhow::anyhow!("sns_native_missing_filedata"))?;
    ensure!(
        !file.is_empty() && file.len() <= MAX_SNS_IMAGE_BYTES,
        "sns_native_file_size_limit"
    );
    let mut metadata = fields.clone();
    metadata.remove("filedata");
    let mut body = pack_cdn(&metadata)?;
    body.extend(pack_cdn(&CdnFields::from([(
        "filedata".to_owned(),
        file.clone(),
    )]))?);
    ensure!(
        body.len() <= MAX_SNS_IMAGE_BYTES + 64 * 1024,
        "sns_native_frame_size_limit"
    );
    let total = u32::try_from(body.len() + SNS_NATIVE_HEADER_BYTES)?;
    let mut frame = Vec::with_capacity(total as usize);
    frame.push(0xab);
    frame.extend(total.to_be_bytes());
    frame.extend(SNS_NATIVE_COMMAND.to_be_bytes());
    frame.extend(uin.to_le_bytes());
    frame.extend([0; 10]);
    frame.extend((body.len() as u32).to_be_bytes());
    frame.extend(body);
    Ok(frame)
}

fn read_sns_native_receipt(reader: &mut impl Read) -> Result<CdnFields> {
    let mut header = [0u8; SNS_NATIVE_HEADER_BYTES];
    reader
        .read_exact(&mut header[..5])
        .map_err(|e| anyhow::anyhow!("sns_native_read_header_{:?}", e.kind()))?;
    ensure!(header[0] == 0xab, "sns_native_invalid_reply_magic");
    let total = u32::from_be_bytes(header[1..5].try_into()?) as usize;
    ensure!(
        (SNS_NATIVE_HEADER_BYTES..=SNS_NATIVE_HEADER_BYTES + MAX_SNS_RECEIPT_BYTES)
            .contains(&total),
        "sns_native_reply_size_limit"
    );
    reader
        .read_exact(&mut header[5..])
        .map_err(|e| anyhow::anyhow!("sns_native_read_header_{:?}", e.kind()))?;
    let body_len = u32::from_be_bytes(header[21..25].try_into()?) as usize;
    ensure!(
        body_len == total - SNS_NATIVE_HEADER_BYTES,
        "sns_native_reply_length_mismatch"
    );
    let mut body = vec![0; body_len];
    reader
        .read_exact(&mut body)
        .map_err(|e| anyhow::anyhow!("sns_native_read_body_{:?}", e.kind()))?;
    unpack_cdn(&body)
}

fn read_complete_sns_receipt(reader: &mut impl Read, expected: usize) -> Result<CdnFields> {
    let mut merged = CdnFields::new();
    let mut received = 0usize;
    for index in 0..MAX_SNS_RECEIPT_FRAMES {
        let frame = read_sns_native_receipt(reader).map_err(|error| {
            anyhow::anyhow!(
                "sns_native_receipt_failed_expected_{expected}_received_{received}_frames_{index}: {error}"
            )
        })?;
        let code = integer(&frame, "retcode")?;
        if code != 0 {
            return Ok(frame);
        }
        let progress = usize::try_from(integer(&frame, "recvlen")?)?;
        ensure!(
            progress >= received && progress <= expected,
            "sns_native_invalid_progress_expected_{expected}_received_{progress}_previous_{received}"
        );
        received = progress;
        merged.extend(frame);
        // Progress acknowledgements and URL-bearing acknowledgements may be
        // separate frames on this connection. Continue reading; never resend.
        if received == expected
            && ["fileurl", "thumburl"]
                .iter()
                .all(|key| merged.get(*key).is_some_and(|value| !value.is_empty()))
        {
            return Ok(merged);
        }
    }
    anyhow::bail!(
        "sns_native_receipt_frame_limit_expected_{expected}_received_{received}_frames_{MAX_SNS_RECEIPT_FRAMES}"
    )
}

struct SnsDeadlineIo<'a> {
    stream: &'a mut TcpStream,
    deadline: Instant,
}

impl Read for SnsDeadlineIo<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        let remaining = self.deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(std::io::ErrorKind::TimedOut.into());
        }
        self.stream.set_read_timeout(Some(remaining))?;
        self.stream.read(buffer)
    }
}

impl Write for SnsDeadlineIo<'_> {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        let remaining = self.deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(std::io::ErrorKind::TimedOut.into());
        }
        self.stream.set_write_timeout(Some(remaining))?;
        self.stream.write(buffer)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.stream.flush()
    }
}

/// SNS uses the separate third GetCDNDns group. Its authentication key and
/// endpoints must remain together rather than borrowing the chat group's key.
pub fn decode_sns_cdn_config(input: &[u8], account: &AccountState) -> Result<CdnConfig> {
    ensure!(input.len() <= 512 * 1024, "sns_cdn_bootstrap_size_limit");
    let response = p::decode(input)?;
    ensure!(p::base_code(&response)? == 0, "sns_cdn_bootstrap_failed");
    let group = p::decode(p::data(&response, 3)?)?;
    let version = u32::try_from(p::scalar(&group, 1)?)?;
    let uin = p::scalar(&group, 2)?;
    ensure!(
        uin == account.uin as u64 && uin != 0,
        "sns_cdn_account_mismatch"
    );
    let auth_key = p::unbuffer(p::data(&group, 8)?)?;
    let mut server_ips = Vec::new();
    for field in group.iter().filter(|f| f.number == 6) {
        ensure!(server_ips.len() < 32, "sns_cdn_endpoint_limit");
        let p::Value::Bytes(raw) = &field.value else {
            anyhow::bail!("sns_cdn_invalid_endpoint");
        };
        let ip_record = p::decode(raw)?;
        let ip = std::str::from_utf8(p::data(&ip_record, 1)?)?.parse()?;
        ensure!(!server_ips.contains(&ip), "sns_cdn_duplicate_endpoint");
        server_ips.push(ip);
    }
    let config = CdnConfig {
        version,
        uin,
        client_version: account.device.client_version as u32,
        client_os_type: account.device.device_type.clone(),
        auth_key,
        server_ips,
        front_id: 0,
        location: None,
    };
    config.validate()?;
    Ok(config)
}

pub struct PreparedSnsImage {
    raw: Vec<u8>,
    width: u32,
    height: u32,
    md5: String,
    sha256: String,
}

impl PreparedSnsImage {
    pub fn from_base64(encoded: &str, expected_sha256: &str) -> Result<Self> {
        ensure!(
            !encoded.is_empty() && encoded.len() <= MAX_SNS_IMAGE_BYTES.div_ceil(3) * 4,
            "sns_image_size_limit"
        );
        ensure!(
            expected_sha256.len() == 64
                && expected_sha256
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()),
            "sns_image_invalid_sha256"
        );
        let raw = STANDARD
            .decode(encoded)
            .map_err(|_| anyhow::anyhow!("sns_image_invalid_base64"))?;
        ensure!(
            !raw.is_empty() && raw.len() <= MAX_SNS_IMAGE_BYTES,
            "sns_image_size_limit"
        );
        let digest = hex::encode(sha256(&raw));
        ensure!(digest == expected_sha256, "sns_image_digest_mismatch");
        ensure!(
            image::guess_format(&raw).ok() == Some(image::ImageFormat::Jpeg),
            "sns_image_expected_jpeg"
        );
        let mut reader =
            image::ImageReader::with_format(std::io::Cursor::new(&raw), image::ImageFormat::Jpeg);
        let mut limits = image::Limits::default();
        limits.max_image_width = Some(MAX_SNS_IMAGE_EDGE);
        limits.max_image_height = Some(MAX_SNS_IMAGE_EDGE);
        limits.max_alloc = Some(32 * 1024 * 1024);
        reader.limits(limits);
        let image = reader
            .decode()
            .map_err(|_| anyhow::anyhow!("sns_image_invalid_jpeg"))?;
        let (width, height) = image.dimensions();
        ensure!(
            width > 0 && height > 0 && width <= MAX_SNS_IMAGE_EDGE && height <= MAX_SNS_IMAGE_EDGE,
            "sns_image_dimensions_limit"
        );
        Ok(Self {
            md5: hex::encode(md5(&raw)),
            sha256: digest,
            raw,
            width,
            height,
        })
    }
}

pub struct UploadedSnsImage {
    pub url: String,
    pub url_type: u32,
    pub thumb_url: String,
    pub thumb_type: u32,
    pub width: u32,
    pub height: u32,
    pub bytes: usize,
    pub md5: String,
    pub sha256: String,
    pub server_received_bytes: usize,
}

fn sns_url(response: &CdnFields, key: &str) -> Result<String> {
    let value = response
        .get(key)
        .ok_or_else(|| anyhow::anyhow!("sns_image_missing_url"))?;
    ensure!(
        !value.is_empty() && value.len() <= 8192,
        "sns_image_invalid_url"
    );
    let value = std::str::from_utf8(value).map_err(|_| anyhow::anyhow!("sns_image_invalid_url"))?;
    ensure!(
        !value.chars().any(|c| c.is_control()),
        "sns_image_invalid_url"
    );
    let url = reqwest::Url::parse(value).map_err(|_| anyhow::anyhow!("sns_image_invalid_url"))?;
    let host = url.host_str().unwrap_or_default();
    ensure!(
        matches!(url.scheme(), "http" | "https")
            && url.username().is_empty()
            && url.password().is_none()
            && url.port().is_none()
            && url.fragment().is_none()
            && ["qpic.cn", "qq.com", "wechat.com", "weixin.qq.com"]
                .iter()
                .any(|domain| host == *domain || host.ends_with(&format!(".{domain}"))),
        "sns_image_invalid_url"
    );
    Ok(value.to_owned())
}

fn sns_image_fields(
    config: &CdnConfig,
    prepared: &PreparedSnsImage,
    sequence: u32,
    file_key: &str,
) -> CdnFields {
    let mut fields = shared(config, sequence, SNS_PHOTO_FILETYPE);
    for (key, value) in [
        ("hasthumb", 0),
        ("compresstype", 0),
        ("enablehit", 0),
        ("existancecheck", 0),
        ("apptype", 101),
        ("offset", 0),
        ("totalsize", prepared.raw.len() as u64),
        ("rawtotalsize", prepared.raw.len() as u64),
        ("thumbtotalsize", 0),
        ("rawthumbsize", 0),
        ("thumbcrc", 0),
        ("filecrc", adler32_zero(&prepared.raw) as u64),
        ("file_format", 0),
        ("mid_format", 0),
        ("advideoflag", 0),
        ("cli-quic-flag", 0),
    ] {
        put(&mut fields, key, value);
    }
    for (key, value) in [
        ("filekey", file_key),
        ("filemd5", prepared.md5.as_str()),
        ("rawfilemd5", prepared.md5.as_str()),
        ("touser", ""),
        ("rawthumbmd5", ""),
        ("setofpicformat", ""),
    ] {
        put(&mut fields, key, value);
    }
    fields.insert("filedata".into(), prepared.raw.clone());
    fields
}

impl CdnClient {
    pub fn upload_sns_image(&self, prepared: &PreparedSnsImage) -> Result<UploadedSnsImage> {
        self.upload_sns_image_with_transport(prepared, |_, fields| self.post_sns_native(fields))
    }

    fn post_sns_native(&self, fields: &CdnFields) -> Result<CdnFields> {
        let frame = sns_native_frame(fields, self.config.uin)?;
        let deadline = Instant::now() + self.timeout;
        let endpoint = SocketAddr::from((self.config.server_ips[0], 443));
        let mut stream =
            TcpStream::connect_timeout(&endpoint, self.timeout.min(Duration::from_secs(10)))
                .map_err(|e| anyhow::anyhow!("sns_native_connect_{:?}", e.kind()))?;
        let mut channel = SnsDeadlineIo {
            stream: &mut stream,
            deadline,
        };
        channel
            .write_all(&frame)
            .map_err(|e| anyhow::anyhow!("sns_native_write_{:?}", e.kind()))?;
        let expected = fields.get("filedata").map_or(0, Vec::len);
        read_complete_sns_receipt(&mut channel, expected)
    }

    fn upload_sns_image_with_transport(
        &self,
        prepared: &PreparedSnsImage,
        mut post: impl FnMut(&str, &CdnFields) -> Result<CdnFields>,
    ) -> Result<UploadedSnsImage> {
        let key = hex::encode(random::<16>()?);
        let fields = sns_image_fields(&self.config, prepared, 1, &key);
        pack_cdn(&fields)?;
        let response = post("/snsuploadbig", &fields)?;
        let code = integer(&response, "retcode")?;
        ensure!(code == 0, "sns_image_server_retcode_{code}");
        let received = usize::try_from(integer(&response, "recvlen")?)?;
        ensure!(
            received == prepared.raw.len(),
            "sns_image_incomplete_receipt_expected_{}_received_{received}",
            prepared.raw.len()
        );
        let url = sns_url(&response, "fileurl")?;
        let thumb_url = sns_url(&response, "thumburl")?;
        Ok(UploadedSnsImage {
            url,
            url_type: 1,
            thumb_url,
            thumb_type: 1,
            width: prepared.width,
            height: prepared.height,
            bytes: prepared.raw.len(),
            md5: prepared.md5.clone(),
            sha256: prepared.sha256.clone(),
            server_received_bytes: received,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{AuthSnapshot, DeviceProfile};
    use std::net::Ipv4Addr;

    #[test]
    fn native_frame_uses_verified_header_and_tail_filedata() {
        let fields = CdnFields::from([
            ("filedata".into(), b"jpg".to_vec()),
            ("seq".into(), b"1".to_vec()),
        ]);
        let frame = sns_native_frame(&fields, 0x12345678).unwrap();
        // Header values: total 56, command 10002, little-endian UIN,
        // ten reserved zero bytes, metadata/file body length 31.
        assert_eq!(
            hex::encode(&frame),
            "ab00000038271278563412000000000000000000000000001f0000000373657100000001310000000866696c6564617461000000036a7067"
        );
        assert!(sns_native_frame(&fields, 0).is_err());
        assert!(sns_native_frame(&CdnFields::new(), 42).is_err());
    }

    #[test]
    fn native_receipt_enforces_frame_bounds_before_parsing() {
        let body = pack_cdn(&CdnFields::from([
            ("retcode".into(), b"0".to_vec()),
            ("recvlen".into(), b"3".to_vec()),
        ]))
        .unwrap();
        let mut frame = vec![0xab];
        frame.extend(((25 + body.len()) as u32).to_be_bytes());
        frame.extend(10002u16.to_be_bytes());
        frame.extend([0; 14]);
        frame.extend((body.len() as u32).to_be_bytes());
        frame.extend(&body);
        let reply = read_sns_native_receipt(&mut std::io::Cursor::new(&frame)).unwrap();
        assert_eq!(integer(&reply, "recvlen").unwrap(), 3);
        for end in [0, 4, 24, frame.len() - 1] {
            assert!(read_sns_native_receipt(&mut std::io::Cursor::new(&frame[..end])).is_err());
        }
        let mut invalid = frame.clone();
        invalid[0] = b'H';
        assert!(read_sns_native_receipt(&mut std::io::Cursor::new(invalid)).is_err());
        let mut invalid = frame.clone();
        invalid[21..25].copy_from_slice(&0u32.to_be_bytes());
        assert!(read_sns_native_receipt(&mut std::io::Cursor::new(invalid)).is_err());
        let mut invalid = frame;
        invalid[1..5].copy_from_slice(&u32::MAX.to_be_bytes());
        assert!(read_sns_native_receipt(&mut std::io::Cursor::new(invalid)).is_err());
    }

    #[test]
    fn progress_frames_are_read_until_complete_without_another_write() {
        fn frame(progress: usize, urls: &[(&str, &str)]) -> Vec<u8> {
            let mut fields = CdnFields::new();
            put(&mut fields, "retcode", 0);
            put(&mut fields, "recvlen", progress);
            for (key, value) in urls {
                put(&mut fields, key, value);
            }
            let body = pack_cdn(&fields).unwrap();
            let mut bytes = vec![0xab];
            bytes.extend(((25 + body.len()) as u32).to_be_bytes());
            bytes.extend(10002u16.to_be_bytes());
            bytes.extend([0; 14]);
            bytes.extend((body.len() as u32).to_be_bytes());
            bytes.extend(body);
            bytes
        }
        let frames = [
            frame(0, &[]),
            frame(262144, &[]),
            frame(311257, &[("fileurl", "https://mmbiz.qpic.cn/main")]),
            frame(311257, &[("thumburl", "https://mmbiz.qpic.cn/thumb")]),
        ]
        .concat();
        let mut reader = std::io::Cursor::new(frames.clone());
        let result = read_complete_sns_receipt(&mut reader, 311257).unwrap();
        assert_eq!(integer(&result, "recvlen").unwrap(), 311257);
        assert!(result.contains_key("fileurl") && result.contains_key("thumburl"));
        assert_eq!(reader.position() as usize, frames.len());

        let partial = frame(262144, &[]);
        let error = read_complete_sns_receipt(&mut std::io::Cursor::new(partial.clone()), 311257)
            .unwrap_err()
            .to_string();
        assert!(error.contains("expected_311257_received_262144_frames_1"));
        for invalid in [
            [partial.clone(), frame(1, &[])].concat(),
            frame(311258, &[]),
            frame(0, &[]).repeat(MAX_SNS_RECEIPT_FRAMES),
        ] {
            assert!(read_complete_sns_receipt(&mut std::io::Cursor::new(invalid), 311257).is_err());
        }
    }

    fn jpeg(width: u32, height: u32) -> Vec<u8> {
        let mut raw = Vec::new();
        let image = image::RgbImage::from_pixel(width, height, image::Rgb([20, 80, 120]));
        image::codecs::jpeg::JpegEncoder::new(&mut raw)
            .encode_image(&image)
            .unwrap();
        raw
    }

    fn prepared() -> PreparedSnsImage {
        let raw = jpeg(32, 24);
        PreparedSnsImage::from_base64(&STANDARD.encode(&raw), &hex::encode(sha256(&raw))).unwrap()
    }

    fn client() -> CdnClient {
        CdnClient::new(
            CdnConfig {
                version: 1,
                uin: 42,
                client_version: 7,
                client_os_type: "test".into(),
                auth_key: b"synthetic".to_vec(),
                server_ips: vec![Ipv4Addr::new(8, 8, 8, 8)],
                front_id: 0,
                location: None,
            },
            Duration::from_secs(5),
        )
        .unwrap()
    }

    fn receipt(bytes: usize) -> CdnFields {
        let mut response = CdnFields::new();
        put(&mut response, "retcode", 0);
        put(&mut response, "recvlen", bytes);
        put(
            &mut response,
            "fileurl",
            "http://mmsns.qpic.cn/sns/synthetic/0",
        );
        put(
            &mut response,
            "thumburl",
            "http://mmsns.qpic.cn/sns/synthetic/150",
        );
        response
    }

    #[test]
    fn sns_bootstrap_keeps_its_own_key_and_rejects_missing_or_mismatched_group() {
        let account = AccountState {
            schema: 1,
            device: DeviceProfile {
                device_id: vec![1; 16],
                device_type: "synthetic-linux".into(),
                client_version: 7,
            },
            uin: 42,
            own_username: "synthetic".into(),
            cookie: vec![5],
            session_key: vec![6; 16],
            request_key: vec![7; 24],
            response_key: vec![8; 24],
            auto_auth_key: vec![],
            key_info: vec![],
            database_password: vec![],
            auth_snapshot: AuthSnapshot::default(),
            long_host: "long.weixin.qq.com".into(),
            short_host: "short.weixin.qq.com".into(),
        };
        let group = |uin: u64, key: &[u8], ip: &[u8]| {
            [
                p::uint(1, 9),
                p::uint(2, uin),
                p::bytes(6, &p::bytes(1, ip)),
                p::bytes(8, &p::buffer(key)),
            ]
            .concat()
        };
        let chat = p::bytes(2, &group(42, b"chat-key", b"8.8.8.8"));
        let base = p::bytes(1, &p::uint(1, 0));
        let sns = group(42, b"sns-key", b"9.9.9.9");
        let config = decode_sns_cdn_config(
            &[base.clone(), chat.clone(), p::bytes(3, &sns)].concat(),
            &account,
        )
        .unwrap();
        assert_eq!(config.auth_key, b"sns-key");
        assert_eq!(config.server_ips, [Ipv4Addr::new(9, 9, 9, 9)]);
        assert!(decode_sns_cdn_config(&[base.clone(), chat.clone()].concat(), &account).is_err());
        for invalid in [
            group(43, b"sns-key", b"9.9.9.9"),
            group(42, b"", b"9.9.9.9"),
            group(42, b"sns-key", b"127.0.0.1"),
        ] {
            assert!(decode_sns_cdn_config(
                &[base.clone(), chat.clone(), p::bytes(3, &invalid)].concat(),
                &account
            )
            .is_err());
        }
    }

    #[test]
    fn sns_image_validates_immutable_bytes_and_jpeg_bounds() {
        let p = prepared();
        assert_eq!((p.width, p.height), (32, 24));
        assert_eq!(p.raw, jpeg(32, 24));
        assert!(PreparedSnsImage::from_base64(&STANDARD.encode(&p.raw), &"0".repeat(64)).is_err());
        assert!(PreparedSnsImage::from_base64("!", &p.sha256).is_err());
        let huge = jpeg(1601, 1);
        assert!(PreparedSnsImage::from_base64(
            &STANDARD.encode(&huge),
            &hex::encode(sha256(&huge))
        )
        .is_err());
        let over = vec![0; MAX_SNS_IMAGE_BYTES + 1];
        assert!(PreparedSnsImage::from_base64(
            &STANDARD.encode(&over),
            &hex::encode(sha256(&over))
        )
        .is_err());
    }

    #[test]
    fn sns_photo_uses_single_plaintext_upload_and_requires_full_receipt() {
        let p = prepared();
        let mut calls = 0;
        let result = client()
            .upload_sns_image_with_transport(&p, |path, fields| {
                calls += 1;
                assert_eq!(path, "/snsuploadbig");
                assert_eq!(integer(fields, "filetype")?, 20201);
                assert_eq!(integer(fields, "apptype")?, 101);
                assert_eq!(integer(fields, "offset")?, 0);
                assert_eq!(integer(fields, "hasthumb")?, 0);
                assert!(!fields.contains_key("thumbdata"));
                assert_eq!(fields["filedata"], p.raw);
                assert_eq!(fields["rawfilemd5"], p.md5.as_bytes());
                Ok(receipt(p.raw.len()))
            })
            .unwrap();
        assert_eq!(calls, 1);
        assert_eq!(result.sha256, p.sha256);
        assert_eq!(result.server_received_bytes, p.raw.len());
        for problem in [
            "retcode",
            "recvlen",
            "fileurl",
            "thumburl",
            "invalidurl",
            "transport",
        ] {
            let mut calls = 0;
            let result = client().upload_sns_image_with_transport(&p, |_, _| {
                calls += 1;
                let mut response = receipt(p.raw.len());
                match problem {
                    "retcode" => put(&mut response, "retcode", -1),
                    "recvlen" => put(&mut response, "recvlen", p.raw.len() - 1),
                    "fileurl" | "thumburl" => {
                        response.remove(problem);
                    }
                    "invalidurl" => put(&mut response, "fileurl", "http://127.0.0.1/image"),
                    _ => anyhow::bail!("uncertain transport"),
                }
                Ok(response)
            });
            assert!(result.is_err(), "{problem}");
            assert_eq!(calls, 1, "never retry: {problem}");
        }
    }
}
