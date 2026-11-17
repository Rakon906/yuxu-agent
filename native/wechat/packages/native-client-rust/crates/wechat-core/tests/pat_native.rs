use serde_json::json;
use sha2::{Digest, Sha256};
use std::sync::Arc;
use wechat_core::Core;
use wechat_store::{Operation, Store};

#[tokio::test]
async fn pat_replay_is_read_only_and_scope_bound_without_credentials() {
    let temp = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open(&temp.path().join("data")).unwrap());
    store.create_account("one").unwrap();
    let key = "sociomem-pat-test";
    let stamp = chrono::Utc::now().to_rfc3339();
    let op = Operation {
        id: format!("pat-{:x}", Sha256::digest(key.as_bytes())),
        account_id: "one".into(),
        kind: "pat".into(),
        state: "submitting".into(),
        result: json!({"groupId":"123@chatroom","targetUserId":"wxid_peer","clientId":key,
            "state":"needs_review","baseCode":null}),
        created_at: stamp.clone(),
        updated_at: stamp,
    };
    assert!(store.operation_optional("one", &op.id).unwrap().is_none());
    store.save_operation(&op).unwrap();
    let core = Core::new(store.clone(), None).unwrap();
    assert_eq!(
        core.send_pat_once("one", "123@chatroom", "wxid_peer", key)
            .await
            .unwrap()["state"],
        "needs_review"
    );
    assert!(core
        .send_pat_once("one", "123@chatroom", "wxid_other", key)
        .await
        .is_err());
    assert!(core
        .send_pat_once("one", "filehelper", "wxid_peer", "other")
        .await
        .is_err());
    assert_eq!(store.operation("one", &op.id).unwrap().state, "submitting");
    assert_eq!(
        core.pat_by_client_id("one", key).unwrap().unwrap()["state"],
        "needs_review"
    );
    assert!(core.pat_by_client_id("one", "not-found").unwrap().is_none());
    drop(core);
    let restarted = Core::new(store, None).unwrap();
    assert_eq!(
        restarted
            .send_pat_once("one", "123@chatroom", "wxid_peer", key)
            .await
            .unwrap()["state"],
        "needs_review"
    );
}
