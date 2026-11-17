//! Read an image referenced by an authenticated Moments detail response.
//! The caller binds the descriptor to its account and media ID before calling.
use super::{public_ipv4, CdnClient};
use crate::crypto::{md5, sha256};
use crate::sns_image_decrypt::decrypt_sns_image_in_place;
use anyhow::{ensure, Result};
use image::GenericImageView;
use reqwest::{header, Url};
use std::collections::{BTreeMap, BTreeSet};
use std::io::{Cursor, Read};
use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
use std::time::{Duration, Instant};
use zeroize::Zeroize;

pub const MAX_SNS_DOWNLOAD_BYTES: usize = 16 * 1024 * 1024;
const MAX_SNS_DOWNLOAD_EDGE: u32 = 8192;
const MAX_SNS_DECODE_ALLOCATION: u64 = 128 * 1024 * 1024;
const MAX_DNS_REPLY_BYTES: usize = 16 * 1024;
const DNS_FALLBACK_URL: &str = "https://dns.alidns.com/resolve";

/// These values are read from the same media element in a fresh, authenticated
/// detail response. A URL's key is a decimal stream-cipher seed, not an AES key.
pub struct SnsImageDescriptor {
    pub url: String,
    pub md5: Option<String>,
    pub key: Option<u64>,
    pub token: Option<String>,
    pub enc_idx: Option<u32>,
    pub expected_bytes: Option<usize>,
}

impl Drop for SnsImageDescriptor {
    fn drop(&mut self) {
        self.url.zeroize();
        self.key.zeroize();
        self.token.zeroize();
    }
}

impl std::fmt::Debug for SnsImageDescriptor {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SnsImageDescriptor")
            .field("descriptor", &"[redacted]")
            .finish()
    }
}

pub struct DownloadedSnsImage {
    pub bytes: Vec<u8>,
    pub content_type: String,
    pub width: u32,
    pub height: u32,
    pub md5: String,
    pub sha256: String,
    /// XML metadata can describe a different server-generated image variant.
    /// These flags report correspondence without asserting a false checksum.
    pub declared_md5_matches: Option<bool>,
    pub declared_bytes_match: Option<bool>,
}

fn download_url(descriptor: &SnsImageDescriptor) -> Result<Url> {
    ensure!(
        !descriptor.url.is_empty() && descriptor.url.len() <= 8192,
        "sns_download_invalid_url"
    );
    let mut url =
        Url::parse(&descriptor.url).map_err(|_| anyhow::anyhow!("sns_download_invalid_url"))?;
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    ensure!(
        matches!(url.scheme(), "http" | "https")
            && (host == "qpic.cn" || host.ends_with(".qpic.cn"))
            && url.username().is_empty()
            && url.password().is_none()
            && url.port().is_none()
            && url.fragment().is_none(),
        "sns_download_invalid_url"
    );
    if let Some(digest) = &descriptor.md5 {
        ensure!(
            digest.len() == 32 && digest.bytes().all(|b| b.is_ascii_hexdigit()),
            "sns_download_invalid_descriptor_md5"
        );
    }
    if let Some(size) = descriptor.expected_bytes {
        ensure!(
            size > 0 && size <= MAX_SNS_DOWNLOAD_BYTES,
            "sns_download_invalid_descriptor_size"
        );
    }
    if let Some(token) = &descriptor.token {
        ensure!(
            !token.is_empty() && token.len() <= 2048 && !token.chars().any(char::is_control),
            "sns_download_invalid_token"
        );
        ensure!(
            descriptor.enc_idx.is_some_and(|idx| idx != 0),
            "sns_download_missing_token_index"
        );
        ensure!(
            descriptor.key.is_some_and(|key| key != 0),
            "sns_download_missing_token_key"
        );
    }
    if let (Some(key), Some(idx)) = (descriptor.key, descriptor.enc_idx) {
        if key != 0 && idx != 0 {
            let retained: Vec<(String, String)> = url
                .query_pairs()
                .filter(|(name, _)| !matches!(name.as_ref(), "token" | "idx"))
                .map(|(name, value)| (name.into_owned(), value.into_owned()))
                .collect();
            url.set_query(None);
            url.query_pairs_mut()
                .extend_pairs(retained)
                .append_pair("idx", &idx.to_string());
            if let Some(token) = &descriptor.token {
                url.query_pairs_mut().append_pair("token", token);
            }
        }
    }
    // No plaintext fallback and no secret key added to a URL or HTTP header.
    url.set_scheme("https")
        .map_err(|_| anyhow::anyhow!("sns_download_invalid_url"))?;
    Ok(url)
}

fn validated_addresses(addresses: impl IntoIterator<Item = SocketAddr>) -> Result<Vec<SocketAddr>> {
    let mut result = Vec::new();
    for (index, address) in addresses.into_iter().enumerate() {
        ensure!(
            index < 64 && result.len() < 32,
            "sns_download_dns_address_limit"
        );
        match address.ip() {
            IpAddr::V4(ip) => {
                ensure!(public_ipv4(ip), "sns_download_dns_not_public");
                let address = SocketAddr::new(IpAddr::V4(ip), 443);
                if !result.contains(&address) {
                    result.push(address);
                }
            }
            // The current native CDN endpoint admission is IPv4 only.
            IpAddr::V6(_) => continue,
        }
    }
    ensure!(!result.is_empty(), "sns_download_dns_no_public_ipv4");
    Ok(result)
}

fn fake_ip(address: IpAddr) -> bool {
    matches!(address, IpAddr::V4(ip) if ip.octets()[0] == 198 && matches!(ip.octets()[1], 18 | 19))
}

fn choose_dns_addresses(
    addresses: Vec<SocketAddr>,
    fallback: impl FnOnce() -> Result<Vec<SocketAddr>>,
) -> Result<Vec<SocketAddr>> {
    ensure!(addresses.len() <= 64, "sns_download_dns_address_limit");
    let needs_fallback = addresses.iter().any(|address| fake_ip(address.ip()));
    if !needs_fallback {
        return validated_addresses(addresses);
    }
    // Only the VPN benchmark/Fake-IP range permits this fallback. A private
    // destination mixed into a response still fails instead of being bypassed.
    for address in &addresses {
        if let IpAddr::V4(ip) = address.ip() {
            ensure!(
                public_ipv4(ip) || fake_ip(address.ip()),
                "sns_download_dns_not_public"
            );
        }
    }
    validated_addresses(fallback()?)
}

fn dns_name(value: &str) -> Result<String> {
    let name = value
        .strip_suffix('.')
        .unwrap_or(value)
        .to_ascii_lowercase();
    ensure!(
        !name.is_empty()
            && name.len() <= 253
            && name.split('.').all(|part| {
                !part.is_empty()
                    && part.len() <= 63
                    && !part.starts_with('-')
                    && !part.ends_with('-')
                    && part.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
            }),
        "sns_download_dns_invalid_name"
    );
    Ok(name)
}

fn parse_dns_reply(raw: &[u8], host: &str) -> Result<Vec<SocketAddr>> {
    ensure!(
        raw.len() <= MAX_DNS_REPLY_BYTES,
        "sns_download_dns_reply_size_limit"
    );
    let reply: serde_json::Value = serde_json::from_slice(raw)
        .map_err(|_| anyhow::anyhow!("sns_download_dns_invalid_reply"))?;
    ensure!(
        reply["Status"].as_u64() == Some(0) && reply["TC"].as_bool() == Some(false),
        "sns_download_dns_unsuccessful_reply"
    );
    let question = match &reply["Question"] {
        serde_json::Value::Array(items) if items.len() == 1 => &items[0],
        value if value.is_object() => value,
        _ => anyhow::bail!("sns_download_dns_invalid_question"),
    };
    let question_name = question["name"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("sns_download_dns_invalid_question"))?;
    let host = dns_name(host)?;
    ensure!(
        dns_name(question_name)? == host && question["type"].as_u64() == Some(1),
        "sns_download_dns_question_mismatch"
    );
    let answers = reply["Answer"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("sns_download_dns_missing_answers"))?;
    ensure!(
        !answers.is_empty() && answers.len() <= 64,
        "sns_download_dns_address_limit"
    );
    let mut aliases = BTreeMap::new();
    let mut records = Vec::new();
    for answer in answers {
        let name = dns_name(
            answer["name"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("sns_download_dns_invalid_answer"))?,
        )?;
        let data = answer["data"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("sns_download_dns_invalid_answer"))?;
        match answer["type"].as_u64() {
            Some(5) => {
                let target = dns_name(data)?;
                if let Some(previous) = aliases.insert(name, target.clone()) {
                    ensure!(previous == target, "sns_download_dns_conflicting_cname");
                }
            }
            Some(1) => {
                let ip = data
                    .parse::<std::net::Ipv4Addr>()
                    .map_err(|_| anyhow::anyhow!("sns_download_dns_invalid_address"))?;
                ensure!(public_ipv4(ip), "sns_download_dns_not_public");
                records.push((name, SocketAddr::new(IpAddr::V4(ip), 443)));
            }
            _ => anyhow::bail!("sns_download_dns_unexpected_record"),
        }
    }
    let mut reached = BTreeSet::new();
    let mut terminal = host;
    while let Some(next) = aliases.get(&terminal) {
        ensure!(
            reached.len() < 8 && reached.insert(terminal.clone()),
            "sns_download_dns_cname_loop"
        );
        terminal = next.clone();
    }
    ensure!(
        aliases.keys().all(|owner| reached.contains(owner)),
        "sns_download_dns_unrelated_cname"
    );
    ensure!(
        records.iter().all(|(owner, _)| owner == &terminal),
        "sns_download_dns_answer_mismatch"
    );
    validated_addresses(records.into_iter().map(|(_, address)| address))
}

fn remaining(deadline: Instant) -> Result<Duration> {
    let duration = deadline.saturating_duration_since(Instant::now());
    ensure!(!duration.is_zero(), "sns_download_deadline_exceeded");
    Ok(duration)
}

fn fallback_dns(host: &str, deadline: Instant) -> Result<Vec<SocketAddr>> {
    // This fixed, certificate-verified service receives only the qpic host.
    // Its own DNS follows the user's VPN; no image URL, key, or token is sent.
    let timeout = remaining(deadline)?.min(Duration::from_secs(8));
    let client = reqwest::blocking::Client::builder()
        .timeout(timeout)
        .connect_timeout(timeout)
        .redirect(reqwest::redirect::Policy::none())
        .referer(false)
        .no_proxy()
        .build()
        .map_err(|_| anyhow::anyhow!("sns_download_dns_client_failed"))?;
    let mut response = client
        .get(DNS_FALLBACK_URL)
        .query(&[("name", host), ("type", "A")])
        .header(header::ACCEPT, "application/dns-json")
        .header(header::ACCEPT_ENCODING, "identity")
        .send()
        .map_err(|_| anyhow::anyhow!("sns_download_dns_fallback_failed"))?;
    ensure!(
        response.status() == 200
            && response
                .headers()
                .get(header::CONTENT_ENCODING)
                .is_none_or(|v| v == "identity"),
        "sns_download_dns_fallback_rejected"
    );
    ensure!(
        response
            .content_length()
            .is_none_or(|length| length <= MAX_DNS_REPLY_BYTES as u64),
        "sns_download_dns_reply_size_limit"
    );
    let mut raw = Vec::new();
    response
        .by_ref()
        .take((MAX_DNS_REPLY_BYTES + 1) as u64)
        .read_to_end(&mut raw)
        .map_err(|_| anyhow::anyhow!("sns_download_dns_reply_read_failed"))?;
    parse_dns_reply(&raw, host)
}

fn encryption_flag(value: Option<&str>) -> Result<bool> {
    match value {
        None | Some("0") => Ok(false),
        Some("1") => Ok(true),
        _ => anyhow::bail!("sns_download_unsupported_encryption"),
    }
}

fn finish_image(
    mut bytes: Vec<u8>,
    encrypted: bool,
    descriptor: &SnsImageDescriptor,
) -> Result<DownloadedSnsImage> {
    ensure!(
        !bytes.is_empty() && bytes.len() <= MAX_SNS_DOWNLOAD_BYTES,
        "sns_download_body_size_limit"
    );
    if encrypted {
        let key = descriptor
            .key
            .ok_or_else(|| anyhow::anyhow!("sns_download_missing_decryption_key"))?;
        decrypt_sns_image_in_place(&mut bytes, key);
    }
    let mut reader = image::ImageReader::new(Cursor::new(&bytes))
        .with_guessed_format()
        .map_err(|_| anyhow::anyhow!("sns_download_invalid_image"))?;
    let format = reader
        .format()
        .ok_or_else(|| anyhow::anyhow!("sns_download_invalid_image"))?;
    ensure!(
        matches!(
            format,
            image::ImageFormat::Jpeg
                | image::ImageFormat::Png
                | image::ImageFormat::Gif
                | image::ImageFormat::WebP
        ),
        "sns_download_unsupported_image_format"
    );
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_SNS_DOWNLOAD_EDGE);
    limits.max_image_height = Some(MAX_SNS_DOWNLOAD_EDGE);
    limits.max_alloc = Some(MAX_SNS_DECODE_ALLOCATION);
    reader.limits(limits);
    let decoded = reader
        .decode()
        .map_err(|_| anyhow::anyhow!("sns_download_invalid_image"))?;
    let (width, height) = decoded.dimensions();
    ensure!(
        width > 0 && height > 0,
        "sns_download_invalid_image_dimensions"
    );
    let actual_md5 = hex::encode(md5(&bytes));
    let actual_sha256 = hex::encode(sha256(&bytes));
    Ok(DownloadedSnsImage {
        declared_md5_matches: descriptor
            .md5
            .as_ref()
            .map(|expected| expected.eq_ignore_ascii_case(&actual_md5)),
        declared_bytes_match: descriptor
            .expected_bytes
            .map(|expected| expected == bytes.len()),
        bytes,
        content_type: format.to_mime_type().to_owned(),
        width,
        height,
        md5: actual_md5,
        sha256: actual_sha256,
    })
}

impl CdnClient {
    pub fn download_sns_image(
        &self,
        descriptor: &SnsImageDescriptor,
    ) -> Result<DownloadedSnsImage> {
        download_sns_image(descriptor, self.timeout)
    }
}

/// The detail request supplies the image authorization token. This transfer
/// does not need another CDN bootstrap request or expose account credentials.
pub fn download_sns_image(
    descriptor: &SnsImageDescriptor,
    timeout: Duration,
) -> Result<DownloadedSnsImage> {
    ensure!(
        !timeout.is_zero() && timeout <= Duration::from_secs(120),
        "sns_download_invalid_timeout"
    );
    let deadline = Instant::now() + timeout;
    let url = download_url(descriptor)?;
    let host = url.host_str().expect("validated URL has a host").to_owned();
    let addresses: Vec<_> = (host.as_str(), 443)
        .to_socket_addrs()
        .map_err(|_| anyhow::anyhow!("sns_download_dns_failed"))?
        .collect();
    let addresses = choose_dns_addresses(addresses, || fallback_dns(&host, deadline))?;
    let timeout = remaining(deadline)?;
    let client = reqwest::blocking::Client::builder()
        .timeout(timeout)
        .connect_timeout(timeout)
        .redirect(reqwest::redirect::Policy::none())
        .referer(false)
        .no_proxy()
        .resolve_to_addrs(&host, &addresses)
        .build()
        .map_err(|_| anyhow::anyhow!("sns_download_client_failed"))?;
    let mut response = client
        .get(url)
        .header(header::USER_AGENT, "MicroMessenger Client")
        .header(header::ACCEPT_ENCODING, "identity")
        .send()
        .map_err(|error| {
            anyhow::anyhow!(
                "sns_download_transport_{}",
                if error.is_timeout() {
                    "timeout"
                } else {
                    "failed"
                }
            )
        })?;
    ensure!(
        response.status() == 200,
        "sns_download_http_status_{}",
        response.status().as_u16()
    );
    let headers = response.headers();
    if let Some(value) = headers.get("x-errno") {
        let text = value
            .to_str()
            .map_err(|_| anyhow::anyhow!("sns_download_invalid_status"))?;
        ensure!(
            text.split(',').all(|value| value.trim() == "0"),
            "sns_download_server_rejected"
        );
    }
    if let Some(value) = headers.get("user-returncode") {
        ensure!(value == "0", "sns_download_server_rejected");
    }
    ensure!(
        headers
            .get("x-info")
            .is_none_or(|value| value == "real data"),
        "sns_download_server_rejected"
    );
    ensure!(
        headers
            .get(header::CONTENT_ENCODING)
            .is_none_or(|value| value == "identity"),
        "sns_download_unsupported_content_encoding"
    );
    let encrypted = encryption_flag(
        headers
            .get("x-enc")
            .map(|value| value.to_str())
            .transpose()
            .map_err(|_| anyhow::anyhow!("sns_download_invalid_encryption_header"))?,
    )?;
    let content_length = response.content_length();
    let declared_transfer_size = headers
        .get("size")
        .map(|value| {
            value
                .to_str()
                .ok()
                .and_then(|text| text.parse::<u64>().ok())
                .ok_or_else(|| anyhow::anyhow!("sns_download_invalid_size_header"))
        })
        .transpose()?;
    if let Some(length) = content_length {
        ensure!(
            length > 0 && length <= MAX_SNS_DOWNLOAD_BYTES as u64,
            "sns_download_body_size_limit"
        );
    }
    if let Some(length) = declared_transfer_size {
        ensure!(
            length > 0 && length <= MAX_SNS_DOWNLOAD_BYTES as u64,
            "sns_download_body_size_limit"
        );
    }
    let mut bytes = Vec::new();
    response
        .by_ref()
        .take((MAX_SNS_DOWNLOAD_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| anyhow::anyhow!("sns_download_body_read_failed"))?;
    if let Some(length) = content_length {
        ensure!(
            length == bytes.len() as u64,
            "sns_download_body_length_mismatch"
        );
    }
    if let Some(length) = declared_transfer_size {
        ensure!(
            length == bytes.len() as u64,
            "sns_download_body_length_mismatch"
        );
    }
    finish_image(bytes, encrypted, descriptor)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn descriptor() -> SnsImageDescriptor {
        SnsImageDescriptor {
            url: "http://example.qpic.cn/image/0?quality=80".to_owned(),
            md5: None,
            key: Some(123456789),
            token: Some("test-token".to_owned()),
            enc_idx: Some(1),
            expected_bytes: None,
        }
    }

    #[test]
    fn url_keeps_query_uses_token_index_and_never_sends_the_cipher_key() {
        let d = descriptor();
        let url = download_url(&d).unwrap();
        assert_eq!(
            url.as_str(),
            "https://example.qpic.cn/image/0?quality=80&idx=1&token=test-token"
        );
        assert!(!url.as_str().contains("123456789"));
        for bad in [
            "http://qpic.cn.evil.test/x",
            "https://127.0.0.1/x",
            "https://user@example.qpic.cn/x",
            "https://example.qpic.cn:8443/x",
            "file:///x",
            "https://example.qpic.cn/x#fragment",
        ] {
            let mut d = descriptor();
            d.url = bad.to_owned();
            assert!(download_url(&d).is_err());
        }
        let mut d = descriptor();
        d.enc_idx = None;
        assert!(download_url(&d).is_err());
    }

    #[test]
    fn dns_cannot_point_to_private_or_synthetic_addresses() {
        for address in [
            "127.0.0.1:443",
            "10.0.0.1:443",
            "198.18.0.1:443",
            "169.254.169.254:443",
            "192.168.1.1:443",
        ] {
            assert!(validated_addresses([address.parse().unwrap()]).is_err());
        }
        let public: SocketAddr = "1.1.1.1:443".parse().unwrap();
        assert_eq!(validated_addresses([public, public]).unwrap(), vec![public]);
        assert!(validated_addresses(["[::1]:443".parse().unwrap()]).is_err());
    }

    #[test]
    fn only_fake_ip_can_trigger_the_dns_fallback() {
        let public: SocketAddr = "1.1.1.1:443".parse().unwrap();
        assert_eq!(
            choose_dns_addresses(vec![public], || panic!("normal DNS must not call DoH")).unwrap(),
            vec![public]
        );
        assert!(
            choose_dns_addresses(vec!["127.0.0.1:443".parse().unwrap()], || panic!(
                "private DNS must not call DoH"
            ))
            .is_err()
        );
        assert_eq!(
            choose_dns_addresses(vec!["198.18.0.133:443".parse().unwrap()], || Ok(vec![
                public
            ]))
            .unwrap(),
            vec![public]
        );
        assert!(choose_dns_addresses(
            vec![
                "198.18.0.133:443".parse().unwrap(),
                "10.0.0.1:443".parse().unwrap()
            ],
            || panic!("mixed private DNS must fail")
        )
        .is_err());
        assert!(
            choose_dns_addresses(vec!["198.18.0.133:443".parse().unwrap()], || Ok(vec![
                "198.18.1.2:443".parse().unwrap()
            ]))
            .is_err()
        );
    }

    #[test]
    fn dns_reply_requires_a_matching_question_and_public_cname_bound_answers() {
        let base = serde_json::json!({"Status":0,"TC":false,
            "Question":{"name":"example.qpic.cn.","type":1},
            "Answer":[{"name":"example.qpic.cn.","type":5,"data":"cdn.example.net."},
                {"name":"cdn.example.net.","type":1,"data":"1.1.1.1"}]});
        let parse = |value: &serde_json::Value| {
            parse_dns_reply(&serde_json::to_vec(value).unwrap(), "example.qpic.cn")
        };
        assert_eq!(parse(&base).unwrap(), vec!["1.1.1.1:443".parse().unwrap()]);
        let mut wrong_question = base.clone();
        wrong_question["Question"]["name"] = "unrelated.qpic.cn".into();
        assert!(parse(&wrong_question).is_err());
        let mut private = base.clone();
        private["Answer"][1]["data"] = "127.0.0.1".into();
        assert!(parse(&private).is_err());
        let mut unrelated = base.clone();
        unrelated["Answer"][1]["name"] = "unrelated.example.net".into();
        assert!(parse(&unrelated).is_err());
        let mut looped = base.clone();
        looped["Answer"][0]["data"] = "example.qpic.cn.".into();
        assert!(parse(&looped).is_err());
        let mut truncated = base.clone();
        truncated["TC"] = true.into();
        assert!(parse(&truncated).is_err());
        let mut rejected = base.clone();
        rejected["Status"] = 3.into();
        assert!(parse(&rejected).is_err());
        let mut array_question = base.clone();
        array_question["Question"] = serde_json::json!([base["Question"].clone()]);
        assert!(parse(&array_question).is_ok());
        assert!(parse_dns_reply(&vec![b' '; MAX_DNS_REPLY_BYTES + 1], "example.qpic.cn").is_err());
    }

    #[test]
    fn encrypted_data_requires_key_and_complete_image_decode() {
        let mut d = descriptor();
        d.key = None;
        assert!(finish_image(vec![1, 2, 3], true, &d).is_err());
        assert!(finish_image(b"<html>not an image</html>".to_vec(), false, &d).is_err());
        assert!(finish_image(vec![0xff, 0xd8, 0xff], false, &d).is_err());
        assert!(encryption_flag(Some("2")).is_err());
        assert!(encryption_flag(Some("invalid")).is_err());
        assert!(encryption_flag(Some("1")).unwrap());
    }

    #[test]
    fn image_variant_reports_actual_digests_and_metadata_correspondence() {
        let image = image::RgbImage::from_pixel(4, 3, image::Rgb([50, 100, 150]));
        let mut bytes = Vec::new();
        image::codecs::jpeg::JpegEncoder::new(&mut bytes)
            .encode_image(&image)
            .unwrap();
        let mut d = descriptor();
        d.md5 = Some("0".repeat(32));
        d.expected_bytes = Some(1);
        let result = finish_image(bytes.clone(), false, &d).unwrap();
        assert_eq!((result.width, result.height), (4, 3));
        assert_eq!(result.content_type, "image/jpeg");
        assert_eq!(result.md5, hex::encode(md5(&bytes)));
        assert_eq!(result.sha256, hex::encode(sha256(&bytes)));
        assert_eq!(result.declared_md5_matches, Some(false));
        assert_eq!(result.declared_bytes_match, Some(false));
    }
}
