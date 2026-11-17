use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use tower::ServiceExt;
use wechat_core::Core;
use wechat_store::Store;

const OWNER: &str = "synthetic-owner-token-0123456789abcdef";
const READER: &str = "synthetic-reader-token-0123456789abcdef";
const SENDER: &str = "synthetic-sender-token-0123456789abcdef";

fn setup() -> (tempfile::TempDir, Router) {
    let temp = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open(&temp.path().join("data")).unwrap());
    store.create_account("one").unwrap();
    store.create_account("two").unwrap();
    for (token, scope) in [(READER, "read"), (SENDER, "send")] {
        let hash = format!("{:x}", Sha256::digest(token));
        store
            .issue_token("synthetic", &hash, &["one".into()], &[scope.into()], None)
            .unwrap();
    }
    let router = wechat_api::router(Core::new(store, None).unwrap(), OWNER);
    (temp, router)
}

async fn call(app: Router, path: &str, token: Option<&str>, body: String) -> (StatusCode, Value) {
    let request = Request::builder()
        .method("POST")
        .uri(path)
        .header("content-type", "application/json");
    let request = match token {
        Some(token) => request.header("authorization", format!("Bearer {token}")),
        None => request,
    };
    let response = app
        .oneshot(request.body(Body::from(body)).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap())
}

#[tokio::test]
async fn sns_image_download_requires_account_scoped_read_and_an_authenticated_native_session() {
    let (_temp, app) = setup();
    let input = json!({"momentId":"123","mediaId":"456"}).to_string();
    let path = "/v1/accounts/one/moments/download-image";
    for token in [None, Some("invalid-token")] {
        assert_eq!(
            call(app.clone(), path, token, input.clone()).await.0,
            StatusCode::UNAUTHORIZED
        );
    }
    assert_eq!(
        call(app.clone(), path, Some(SENDER), input.clone()).await.0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(
            app.clone(),
            "/v1/accounts/two/moments/download-image",
            Some(READER),
            input.clone()
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    for token in [OWNER, READER] {
        let (status, body) = call(app.clone(), path, Some(token), input.clone()).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(
            body,
            json!({"error":{"code":"moments_image_auth_required"}})
        );
    }
}

#[tokio::test]
async fn sns_image_download_accepts_only_canonical_ids_and_never_echoes_credential_fields() {
    let (_temp, app) = setup();
    let path = "/v1/accounts/one/moments/download-image";
    for id in [
        "0",
        "01",
        "-1",
        "18446744073709551616",
        "https://secret.example/key",
    ] {
        let (status, body) = call(
            app.clone(),
            path,
            Some(READER),
            json!({"momentId":id,"mediaId":"456"}).to_string(),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body, json!({"error":{"code":"moments_image_invalid_id"}}));
    }
    for body in [
        json!({"momentId":"123","mediaId":"456","url":"https://secret.example/key"}),
        json!({"momentId":"123","mediaId":"456","token":"secret"}),
        json!({"momentId":"123","mediaId":"456","key":"secret"}),
        json!({"momentId":"123","mediaId":456}),
        json!({"momentId":"123"}),
    ] {
        let (status, result) = call(app.clone(), path, Some(READER), body.to_string()).await;
        assert!(status.is_client_error());
        assert_eq!(
            result,
            json!({"error":{"code":"moments_image_invalid_request"}})
        );
    }
    let (status, body) = call(app.clone(), path, Some(READER), " ".repeat(1025)).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(
        body,
        json!({"error":{"code":"moments_image_invalid_request"}})
    );
    let (status, body) = call(
        app,
        "/v1/accounts/missing/moments/download-image",
        Some(OWNER),
        json!({"momentId":"123","mediaId":"456"}).to_string(),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(
        body,
        json!({"error":{"code":"moments_image_account_unavailable"}})
    );
}
