//! Moments (SNS) diagnostic transport on the existing desktop session.
//!
//! Read commands are separate from writes. Publishing (`mmsnspost`), commenting
//! (`mmsnscomment`) and object operations require the caller's explicit `write`
//! flag. A route being available does not establish that a supplied request is
//! valid or that a post is visible. Callers must persist write intent before
//! dispatch, check receipts, and never automatically resend uncertain outcomes.
//!
//! `mmsnstimeline` / `mmsnsobjectdetail` / `mmsnssync` accept a protobuf body the
//! official client builds from its own schema. Until that schema is confirmed on
//! 4.1.13.26, callers send an explicit body and receive the raw reply. The reply
//! is bounded and never parsed into unverified typed fields.
use crate::client::{AccountState, NativeClient};
use crate::protobuf as p;
use anyhow::{bail, ensure, Result};

/// Largest request body a caller may hand to the daemon.
pub const MAX_REQUEST_BYTES: usize = 64 * 1024;
/// Largest reply the daemon forwards to a caller.
pub const MAX_REPLY_BYTES: usize = 4 * 1024 * 1024;

/// `mmsnspost` — publish an object; available only through the write path.
pub const SNS_POST: u16 = 209;
/// `mmsnsobjectdetail` — one object's timeline id and owner.
pub const SNS_OBJECT_DETAIL: u16 = 210;
/// `mmsnstimeline` — the feed itself.
pub const SNS_TIMELINE: u16 = 211;
/// `mmsnssync` — incremental feed notifications.
pub const SNS_SYNC: u16 = 214;
/// `mmsnsobjectop` — object operations such as like/hide/delete.
pub const SNS_OBJECT_OP: u16 = 218;
/// `mmsnscomment` — like and comment actions.
pub const SNS_COMMENT: u16 = 213;

/// Exact cgi path for a read-only Moments command id.
///
/// The ids come from the official 4.1.13.26 client's command table; the same
/// ids are visible in its error reporting (`0xd2`, `0xd3`, `0xd6`).
pub fn read_path(cgi: u16) -> Result<&'static str> {
    match cgi {
        SNS_OBJECT_DETAIL => Ok("/cgi-bin/micromsg-bin/mmsnsobjectdetail"),
        SNS_TIMELINE => Ok("/cgi-bin/micromsg-bin/mmsnstimeline"),
        SNS_SYNC => Ok("/cgi-bin/micromsg-bin/mmsnssync"),
        _ => bail!("Unsupported read-only SNS cgi"),
    }
}

/// Write cgis exposed only through the explicit diagnostic flag.
pub fn write_path(cgi: u16) -> Result<&'static str> {
    match cgi {
        SNS_POST => Ok("/cgi-bin/micromsg-bin/mmsnspost"),
        SNS_OBJECT_OP => Ok("/cgi-bin/micromsg-bin/mmsnsobjectop"),
        SNS_COMMENT => Ok("/cgi-bin/micromsg-bin/mmsnscomment"),
        _ => bail!("Unsupported write SNS cgi"),
    }
}

/// Base response fields a caller can rely on when the payload schema is unknown.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct BaseStatus {
    pub code: Option<i64>,
    pub message: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SnsProbe {
    pub cgi: u16,
    pub path: &'static str,
    pub request_bytes: usize,
    pub reply: Vec<u8>,
    pub base: BaseStatus,
}

/// Send one Moments request on the account's existing session.
/// A write endpoint is inaccessible unless `write` is true.
///
/// The caller supplies the protobuf body; this function only bounds it and
/// reports the raw reply. Nothing is written to the official profile.
pub fn probe(
    client: &NativeClient,
    state: &mut AccountState,
    cgi: u16,
    body: &[u8],
    with_base_request: bool,
    write: bool,
) -> Result<SnsProbe> {
    let path = if write {
        write_path(cgi)?
    } else {
        read_path(cgi)?
    };
    ensure!(body.len() <= MAX_REQUEST_BYTES, "SNS request too large");
    let request = if with_base_request {
        let base = crate::wire::base_request(&state.device, state.uin, 0)?;
        p::message(&[p::bytes(1, &base), body.to_vec()])?
    } else {
        body.to_vec()
    };
    ensure!(request.len() <= MAX_REQUEST_BYTES, "SNS request too large");
    let reply = client.authenticated_rpc(state, cgi, path, &request)?;
    ensure!(reply.len() <= MAX_REPLY_BYTES, "SNS reply too large");
    let base = base_status(&reply);
    Ok(SnsProbe {
        cgi,
        path,
        request_bytes: request.len(),
        reply,
        base,
    })
}

/// Lenient BaseResponse reader: unknown schema must not hide a server error.
fn base_status(reply: &[u8]) -> BaseStatus {
    let mut status = BaseStatus::default();
    let Ok(fields) = p::decode(reply) else {
        return status;
    };
    let Some(p::Value::Bytes(base)) = fields
        .iter()
        .find(|field| field.number == 1)
        .map(|field| &field.value)
    else {
        return status;
    };
    let Ok(inner) = p::decode(base) else {
        return status;
    };
    for field in &inner {
        match (field.number, &field.value) {
            (1, p::Value::Varint(value)) if status.code.is_none() => {
                status.code = Some(*value as u32 as i32 as i64);
            }
            (2, p::Value::Bytes(value)) if status.message.is_none() => {
                status.message = String::from_utf8(value.clone()).ok();
            }
            _ => {}
        }
    }
    status
}

pub fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(char::from_digit((byte >> 4) as u32, 16).unwrap());
        out.push(char::from_digit((byte & 15) as u32, 16).unwrap());
    }
    out
}

pub fn hex_decode(input: &str) -> Result<Vec<u8>> {
    ensure!(
        input.len().is_multiple_of(2),
        "SNS request hex must have an even length"
    );
    ensure!(
        input.len() / 2 <= MAX_REQUEST_BYTES,
        "SNS request too large"
    );
    let mut out = Vec::with_capacity(input.len() / 2);
    let bytes = input.as_bytes();
    for pair in bytes.chunks_exact(2) {
        let high = hex_value(pair[0])?;
        let low = hex_value(pair[1])?;
        out.push((high << 4) | low);
    }
    Ok(out)
}

fn hex_value(byte: u8) -> Result<u8> {
    match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'a'..=b'f' => Ok(byte - b'a' + 10),
        b'A'..=b'F' => Ok(byte - b'A' + 10),
        _ => bail!("SNS request hex contains a non-hex character"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_require_the_separate_write_path() {
        for cgi in [209u16, 212, 213, 215] {
            assert!(
                read_path(cgi).is_err(),
                "{cgi} must not be available through read_path"
            );
        }
        assert_eq!(
            read_path(211).unwrap(),
            "/cgi-bin/micromsg-bin/mmsnstimeline"
        );
        assert_eq!(
            write_path(218).unwrap(),
            "/cgi-bin/micromsg-bin/mmsnsobjectop"
        );
        assert_eq!(
            write_path(213).unwrap(),
            "/cgi-bin/micromsg-bin/mmsnscomment"
        );
        assert_eq!(write_path(209).unwrap(), "/cgi-bin/micromsg-bin/mmsnspost");
        assert!(write_path(207).is_err());
        assert!(write_path(208).is_err());
        assert!(write_path(211).is_err());
    }

    #[test]
    fn hex_round_trips_and_rejects_junk() {
        let bytes = [0u8, 1, 0xde, 0xad, 0xff];
        assert_eq!(hex_decode(&hex_encode(&bytes)).unwrap(), bytes);
        assert_eq!(hex_encode(&[]), "");
        assert!(hex_decode("abc").is_err());
        assert!(hex_decode("zz").is_err());
        assert!(hex_decode(&"00".repeat(MAX_REQUEST_BYTES + 1)).is_err());
    }

    #[test]
    fn base_status_reads_code_and_message() {
        let base = p::message(&[p::int32(1, -301), p::bytes(2, b"redirect")]).unwrap();
        let reply = p::message(&[p::bytes(1, &base)]).unwrap();
        let status = base_status(&reply);
        assert_eq!(status.code, Some(-301));
        assert_eq!(status.message.as_deref(), Some("redirect"));
    }

    #[test]
    fn base_status_tolerates_unknown_shapes() {
        assert_eq!(base_status(&[]), BaseStatus::default());
        assert_eq!(base_status(b"\x08\x01"), BaseStatus::default());
        let base = p::message(&[p::uint(9, 1)]).unwrap();
        let reply = p::message(&[p::bytes(1, &base)]).unwrap();
        assert_eq!(base_status(&reply), BaseStatus::default());
    }
}
