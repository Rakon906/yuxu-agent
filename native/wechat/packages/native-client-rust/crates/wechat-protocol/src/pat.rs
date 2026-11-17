//! Single SendPat RPC. Official Linux 4.1.13.26 evidence: builder 0x6beec60,
//! CGI wrapper 0x6bf4310, protobuf serializers 0x7cf6810/0x7cf7420.
use crate::{
    client::{AccountState, NativeClient},
    protobuf as p,
};
use anyhow::{ensure, Result};

pub const SEND_PAT_CGI: u16 = 849;
pub const SEND_PAT_PATH: &str = "/cgi-bin/micromsg-bin/sendpat";
pub fn identity(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.@-".contains(&b))
}
pub fn validate(group: &str, target: &str, client_id: &str) -> Result<()> {
    ensure!(
        identity(group) && group.ends_with("@chatroom"),
        "pat_requires_group"
    );
    ensure!(
        identity(target) && !target.contains('@'),
        "invalid_pat_target"
    );
    ensure!(
        !client_id.is_empty()
            && client_id.len() <= 128
            && client_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b)),
        "invalid_pat_client_id"
    );
    Ok(())
}
pub fn request(
    base: &[u8],
    from: &str,
    group: &str,
    target: &str,
    client_id: &str,
) -> Result<Vec<u8>> {
    validate(group, target, client_id)?;
    ensure!(
        identity(from) && from != target && !from.contains('@'),
        "invalid_pat_sender"
    );
    ensure!(!base.is_empty() && base.len() < 4096, "invalid_pat_base");
    p::message(&[
        p::bytes(1, base),
        p::bytes(2, from.as_bytes()),
        p::bytes(3, group.as_bytes()),
        p::bytes(4, target.as_bytes()),
        p::bytes(5, client_id.as_bytes()),
        p::uint(6, 0),
    ])
}
#[derive(Debug, Clone)]
pub struct PatReply {
    pub base_code: i32,
    pub message_id: Option<u64>,
}
pub fn decode_reply(reply: &[u8]) -> Result<PatReply> {
    ensure!(reply.len() <= 64 * 1024, "pat_reply_too_large");
    let fields = p::decode(reply)?;
    let bases = fields.iter().filter(|f| f.number == 1).collect::<Vec<_>>();
    ensure!(bases.len() == 1, "pat_missing_or_duplicate_base");
    let p::Value::Bytes(base) = &bases[0].value else {
        anyhow::bail!("pat_invalid_base")
    };
    let base = p::decode(base)?;
    let codes = base.iter().filter(|f| f.number == 1).collect::<Vec<_>>();
    ensure!(codes.len() == 1, "pat_missing_or_duplicate_code");
    let p::Value::Varint(code) = codes[0].value else {
        anyhow::bail!("pat_invalid_code")
    };
    let ids = fields.iter().filter(|f| f.number == 5).collect::<Vec<_>>();
    ensure!(ids.len() <= 1, "pat_duplicate_message_id");
    let message_id = if let Some(field) = ids.first() {
        let p::Value::Varint(value) = field.value else {
            anyhow::bail!("pat_invalid_message_id")
        };
        (value != 0).then_some(value)
    } else {
        None
    };
    Ok(PatReply {
        base_code: code as u32 as i32,
        message_id,
    })
}
impl NativeClient {
    pub fn send_pat_once(
        &self,
        state: &mut AccountState,
        group: &str,
        target: &str,
        client_id: &str,
    ) -> Result<PatReply> {
        let base = crate::wire::base_request(&state.device, state.uin, 0)?;
        let body = request(&base, &state.own_username, group, target, client_id)?;
        decode_reply(&self.authenticated_rpc(state, SEND_PAT_CGI, SEND_PAT_PATH, &body)?)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn official_request_wire_layout_and_sender_binding() {
        let body = request(
            &[8, 1],
            "wxid_self",
            "123@chatroom",
            "wxid_friend",
            "test-123",
        )
        .unwrap();
        let expected = [
            p::bytes(1, &[8, 1]),
            p::bytes(2, b"wxid_self"),
            p::bytes(3, b"123@chatroom"),
            p::bytes(4, b"wxid_friend"),
            p::bytes(5, b"test-123"),
            p::uint(6, 0),
        ]
        .concat();
        assert_eq!(body, expected);
        assert!(request(
            &[8, 1],
            "wxid_self",
            "123@chatroom",
            "wxid_self",
            "test-123"
        )
        .is_err());
        assert!(validate("filehelper", "wxid_friend", "test-123").is_err());
        assert!(validate("123@chatroom", "other@chatroom", "test-123").is_err());
    }
    #[test]
    fn reply_preserves_u64_and_signed_codes_and_rejects_ambiguity() {
        let raw = [p::bytes(1, &p::uint(1, 0)), p::uint(5, u64::MAX)].concat();
        let decoded = decode_reply(&raw).unwrap();
        assert_eq!(decoded.base_code, 0);
        assert_eq!(decoded.message_id, Some(u64::MAX));
        assert_eq!(
            decode_reply(&p::bytes(1, &p::int32(1, -1)))
                .unwrap()
                .base_code,
            -1
        );
        assert!(decode_reply(&[]).is_err());
        assert!(decode_reply(&[raw.clone(), p::uint(5, 1)].concat()).is_err());
        assert!(decode_reply(&[raw, p::bytes(1, &p::uint(1, 0))].concat()).is_err());
    }
}
