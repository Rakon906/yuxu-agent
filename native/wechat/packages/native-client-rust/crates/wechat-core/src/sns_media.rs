//! Resolve a media identifier from a fresh authenticated SNS object response.
//! Caller-supplied URLs and dimension-only associations are never accepted.
use anyhow::{ensure, Context, Result};
use base64::Engine;
use roxmltree::{Document, Node, ParsingOptions};
use wechat_protocol::protobuf as p;

pub(crate) struct BoundSnsImage {
    pub moment_id: String,
    pub media_id: String,
    pub url: String,
    pub md5: String,
    pub key: Option<String>,
    pub token: Option<String>,
    pub aes_key: Option<String>,
    pub enc_idx: Option<u32>,
    pub bytes: Option<usize>,
}

pub(crate) async fn guarded_blocking<T: Send + 'static, P: Send + 'static>(
    guard: tokio::sync::OwnedMutexGuard<()>,
    permit: P,
    work: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tokio::task::spawn_blocking(move || {
        // An aborted HTTP future must not release account serialization or
        // download slots while this worker still reads/saves its session.
        let _guard = guard;
        let _permit = permit;
        work()
    })
    .await
    .context("sns_image_worker_unavailable")?
}

pub(crate) fn identifier(value: &str) -> Result<u64> {
    let number = value.parse::<u64>()?;
    ensure!(
        number != 0 && number.to_string() == value,
        "sns_image_invalid_id"
    );
    Ok(number)
}

fn child<'a, 'input>(node: Node<'a, 'input>, name: &str) -> Result<Node<'a, 'input>> {
    let mut found = node.children().filter(|n| n.has_tag_name(name));
    let result = found
        .next()
        .ok_or_else(|| anyhow::anyhow!("sns_image_missing_xml_field"))?;
    ensure!(
        found.next().is_none() && result.tag_name().namespace().is_none(),
        "sns_image_ambiguous_xml_field"
    );
    Ok(result)
}

fn text<'a, 'input>(node: Node<'a, 'input>) -> Result<&'a str> {
    ensure!(
        !node.children().any(|n| n.is_element()),
        "sns_image_nested_text"
    );
    Ok(node.text().unwrap_or_default().trim())
}

fn attribute(node: Node<'_, '_>, name: &str, max: usize) -> Result<Option<String>> {
    node.attribute(name)
        .map(|value| {
            ensure!(
                !value.is_empty() && value.len() <= max && !value.chars().any(char::is_control),
                "sns_image_invalid_attribute"
            );
            Ok(value.to_owned())
        })
        .transpose()
}

pub(crate) fn from_detail(reply: &[u8], moment_id: &str, media_id: &str) -> Result<BoundSnsImage> {
    let expected = identifier(moment_id)?;
    identifier(media_id)?;
    ensure!(
        !reply.is_empty() && reply.len() <= 4 * 1024 * 1024,
        "sns_image_detail_size_limit"
    );
    let envelope = p::decode(reply)?;
    ensure!(p::base_code(&envelope)? == 0, "sns_image_detail_rejected");
    let object = p::decode(p::data(&envelope, 2)?)?;
    ensure!(
        p::scalar(&object, 1)? == expected,
        "sns_image_moment_mismatch"
    );
    let author = std::str::from_utf8(p::data(&object, 2)?)?;
    ensure!(!author.is_empty(), "sns_image_missing_author");
    let xml = p::unbuffer(p::data(&object, 5)?)?;
    ensure!(xml.len() <= 256 * 1024, "sns_image_xml_size_limit");
    let xml = std::str::from_utf8(&xml)?;
    let doc = Document::parse_with_options(
        xml,
        ParsingOptions {
            allow_dtd: false,
            nodes_limit: 10000,
            ..Default::default()
        },
    )?;
    let root = doc.root_element();
    ensure!(
        root.has_tag_name("TimelineObject") && root.tag_name().namespace().is_none(),
        "sns_image_invalid_xml_root"
    );
    ensure!(
        text(child(root, "id")?)? == moment_id,
        "sns_image_xml_moment_mismatch"
    );
    ensure!(
        text(child(root, "username")?)? == author,
        "sns_image_author_mismatch"
    );
    let list = child(child(root, "ContentObject")?, "mediaList")?;
    let items: Vec<_> = list.children().filter(|n| n.is_element()).collect();
    ensure!(
        !items.is_empty() && items.len() <= 9,
        "sns_image_media_count_limit"
    );
    let mut selected = None;
    let mut ids = std::collections::HashSet::new();
    for item in items {
        ensure!(
            item.has_tag_name("media") && item.tag_name().namespace().is_none(),
            "sns_image_invalid_media_node"
        );
        let id = text(child(item, "id")?)?;
        identifier(id)?;
        ensure!(ids.insert(id), "sns_image_duplicate_media_id");
        if id == media_id {
            selected = Some(item);
        }
    }
    let item = selected.ok_or_else(|| anyhow::anyhow!("sns_image_media_not_found"))?;
    ensure!(text(child(item, "type")?)? == "2", "sns_image_not_photo");
    let url_node = child(item, "url")?;
    let url = text(url_node)?;
    ensure!(
        !url.is_empty() && url.len() <= 8192 && !url.chars().any(char::is_control),
        "sns_image_invalid_url"
    );
    let md5 = attribute(url_node, "md5", 32)?
        .ok_or_else(|| anyhow::anyhow!("sns_image_missing_digest"))?;
    ensure!(
        md5.len() == 32 && md5.bytes().all(|b| b.is_ascii_hexdigit()),
        "sns_image_invalid_digest"
    );
    let size = child(item, "size")?;
    let bytes = attribute(size, "totalSize", 20)?
        .map(|v| {
            let n = v.strip_suffix(".0").unwrap_or(&v).parse::<usize>()?;
            ensure!(n > 0 && n <= 16 * 1024 * 1024, "sns_image_size_limit");
            Ok::<_, anyhow::Error>(n)
        })
        .transpose()?;
    Ok(BoundSnsImage {
        moment_id: moment_id.to_owned(),
        media_id: media_id.to_owned(),
        url: url.to_owned(),
        md5: md5.to_lowercase(),
        key: attribute(url_node, "key", 128)?,
        token: attribute(url_node, "token", 4096)?,
        aes_key: attribute(url_node, "aeskey", 128)?,
        enc_idx: attribute(url_node, "enc_idx", 10)?
            .map(|v| v.parse())
            .transpose()?,
        bytes,
    })
}

/// The wire descriptor may name the original while the CDN serves a variant.
/// Preserve both actual content digests and declared metadata; the authenticated
/// object/media association is explicitly distinguished from checksum equality.
pub(crate) fn response(
    account: &str,
    bound: &BoundSnsImage,
    image: wechat_protocol::media::DownloadedSnsImage,
) -> serde_json::Value {
    serde_json::json!({
        "ok": true,
        "accountId": account,
        "momentId": bound.moment_id,
        "mediaId": bound.media_id,
        "verifiedSource": "authenticated-sns-media-v1",
        "imageBase64": base64::engine::general_purpose::STANDARD.encode(&image.bytes),
        "md5": image.md5,
        "sha256": image.sha256,
        "bytes": image.bytes.len(),
        "contentType": image.content_type,
        "width": image.width,
        "height": image.height,
        "declaredMd5": bound.md5,
        "declaredBytes": bound.bytes,
        "declaredMd5Matches": bound.md5.eq_ignore_ascii_case(&image.md5),
        "declaredBytesMatch": bound.bytes.map(|size| size == image.bytes.len()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn cancelled_download_holds_account_gate_and_permits_until_worker_finishes() {
        use std::{sync::Arc, time::Duration};
        let gate = Arc::new(tokio::sync::Mutex::new(()));
        let account_slots = Arc::new(tokio::sync::Semaphore::new(1));
        let global_slots = Arc::new(tokio::sync::Semaphore::new(1));
        let permit = (
            account_slots.clone().acquire_owned().await.unwrap(),
            global_slots.clone().acquire_owned().await.unwrap(),
        );
        let guard = gate.clone().lock_owned().await;
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let request = tokio::spawn(guarded_blocking(guard, permit, move || {
            let _ = started_tx.send(());
            release_rx.recv_timeout(Duration::from_secs(3))?;
            Ok(())
        }));
        tokio::time::timeout(Duration::from_secs(2), started_rx)
            .await
            .unwrap()
            .unwrap();
        request.abort();
        assert!(request.await.unwrap_err().is_cancelled());
        assert!(
            gate.try_lock().is_err(),
            "account gate must outlive the HTTP request"
        );
        assert_eq!(account_slots.available_permits(), 0);
        assert_eq!(global_slots.available_permits(), 0);
        release_tx.send(()).unwrap();
        let _next = tokio::time::timeout(Duration::from_secs(2), gate.lock())
            .await
            .unwrap();
        let _account = tokio::time::timeout(Duration::from_secs(2), account_slots.acquire())
            .await
            .unwrap()
            .unwrap();
        let _global = tokio::time::timeout(Duration::from_secs(2), global_slots.acquire())
            .await
            .unwrap()
            .unwrap();
    }
    fn xml() -> String {
        "<TimelineObject><id>123</id><username>synthetic_author</username><ContentObject><mediaList><media><id>456</id><type>2</type><url md5=\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\" key=\"987654321\" token=\"synthetic-token\" enc_idx=\"1\">https://mmsns.qpic.cn/mmsns/synthetic/0</url><size width=\"800\" height=\"600\" totalSize=\"1024\"/></media></mediaList></ContentObject></TimelineObject>".into()
    }
    fn envelope(xml: &str, id: u64, author: &str) -> Vec<u8> {
        p::message(&[
            p::bytes(1, &p::uint(1, 0)),
            p::bytes(
                2,
                &p::message(&[
                    p::uint(1, id),
                    p::bytes(2, author.as_bytes()),
                    p::bytes(5, &p::buffer(xml.as_bytes())),
                ])
                .unwrap(),
            ),
        ])
        .unwrap()
    }
    #[test]
    fn image_binding_requires_both_object_and_media_identity() {
        let reply = envelope(&xml(), 123, "synthetic_author");
        let bound = from_detail(&reply, "123", "456").unwrap();
        assert_eq!(bound.moment_id, "123");
        assert_eq!(bound.media_id, "456");
        assert_eq!(bound.bytes, Some(1024));
        assert_eq!(bound.enc_idx, Some(1));
        assert_eq!(bound.key.as_deref(), Some("987654321"));
        assert_eq!(bound.token.as_deref(), Some("synthetic-token"));
        assert!(bound.aes_key.is_none());
        assert_eq!(bound.md5, "a".repeat(32));
        assert!(bound.url.starts_with("https://"));
        assert!(from_detail(&reply, "124", "456").is_err());
        assert!(from_detail(&reply, "123", "457").is_err());
        assert!(from_detail(&envelope(&xml(), 123, "wrong_author"), "123", "456").is_err());
        assert!(from_detail(
            &envelope(
                &xml().replace("<id>123</id>", "<id>124</id>"),
                123,
                "synthetic_author"
            ),
            "123",
            "456"
        )
        .is_err());
    }
    #[test]
    fn ambiguous_invalid_and_unverified_descriptors_are_rejected() {
        for xml in [
            xml().replace("<id>456</id>", "<id>456</id><id>457</id>"),
            xml().replace("<type>2</type>", "<type>6</type>"),
            xml().replace("md5=\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"", ""),
            xml().replace(
                "md5=\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"",
                "md5=\"not-a-hash\"",
            ),
            xml().replace("totalSize=\"1024\"", "totalSize=\"999999999\""),
            xml().replace(
                "<TimelineObject>",
                "<!DOCTYPE TimelineObject [<!ENTITY x 'injected'>]><TimelineObject>",
            ),
        ] {
            assert!(from_detail(&envelope(&xml, 123, "synthetic_author"), "123", "456").is_err());
        }
        for value in ["0", "-1", "01", "18446744073709551616", "123.0"] {
            assert!(identifier(value).is_err());
        }
        assert!(identifier("18446744073709551615").is_ok());
    }

    #[test]
    fn duplicate_objects_or_duplicate_media_ids_cannot_bind_an_image() {
        let valid = envelope(&xml(), 123, "synthetic_author");
        let duplicate_object = [valid.as_slice(), &p::bytes(2, &[])].concat();
        assert!(from_detail(&duplicate_object, "123", "456").is_err());
        let duplicate_media = xml().replace("</mediaList>",
            "<media><id>456</id><type>2</type><url md5=\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\">https://mmsns.qpic.cn/other</url><size totalSize=\"1024\"/></media></mediaList>");
        assert!(from_detail(
            &envelope(&duplicate_media, 123, "synthetic_author"),
            "123",
            "456"
        )
        .is_err());
    }

    #[test]
    fn source_proof_keeps_variant_mismatches_explicit_without_exposing_credentials() {
        use sha2::Digest;
        let mut bound =
            from_detail(&envelope(&xml(), 123, "synthetic_author"), "123", "456").unwrap();
        let bytes = b"synthetic-decoded-image".to_vec();
        let actual_md5 = format!("{:x}", md5::Md5::digest(&bytes));
        let actual_sha256 = format!("{:x}", sha2::Sha256::digest(&bytes));
        let image = || wechat_protocol::media::DownloadedSnsImage {
            bytes: bytes.clone(),
            content_type: "image/jpeg".into(),
            width: 720,
            height: 1280,
            md5: actual_md5.clone(),
            sha256: actual_sha256.clone(),
            // The response derives these independently from its bound object.
            declared_md5_matches: Some(true),
            declared_bytes_match: Some(true),
        };
        let value = response("synthetic-account", &bound, image());
        assert_eq!(value["verifiedSource"], "authenticated-sns-media-v1");
        assert_eq!(value["accountId"], "synthetic-account");
        assert_eq!(value["momentId"], "123");
        assert_eq!(value["mediaId"], "456");
        assert_eq!(value["bytes"], bytes.len());
        assert_eq!(value["md5"], actual_md5);
        assert_eq!(value["sha256"], actual_sha256);
        assert_eq!(value["declaredMd5"], "a".repeat(32));
        assert_eq!(value["declaredBytes"], 1024);
        assert_eq!(value["declaredMd5Matches"], false);
        assert_eq!(value["declaredBytesMatch"], false);
        let encoded = value.to_string();
        for secret in [
            &bound.url,
            bound.token.as_ref().unwrap(),
            bound.key.as_ref().unwrap(),
        ] {
            assert!(!encoded.contains(secret));
        }
        assert!(value.get("url").is_none());
        assert!(value.get("token").is_none());
        assert!(value.get("key").is_none());
        assert!(value.get("aesKey").is_none());
        bound.md5 = actual_md5.clone();
        bound.bytes = Some(bytes.len());
        let exact = response("synthetic-account", &bound, image());
        assert_eq!(exact["declaredMd5Matches"], true);
        assert_eq!(exact["declaredBytesMatch"], true);
        bound.bytes = None;
        assert!(response("synthetic-account", &bound, image())["declaredBytesMatch"].is_null());
    }
}
