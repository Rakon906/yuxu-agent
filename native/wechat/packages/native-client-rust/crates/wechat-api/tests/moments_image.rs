use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use std::sync::Arc;
use tower::ServiceExt;
use wechat_core::Core;
use wechat_store::Store;

#[tokio::test]
async fn moments_image_has_its_own_body_bound_and_requires_authentication() {
    let temp = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open(&temp.path().join("data")).unwrap());
    store.create_account("one").unwrap();
    let token = "0123456789abcdef0123456789abcdef";
    let app = wechat_api::router(Core::new(store, None).unwrap(), token);
    let body = json!({"imageBase64": "A".repeat(1400000), "sha256": "0".repeat(64)}).to_string();
    let request = |path: &str, body: String, auth: bool| {
        let builder = Request::builder()
            .method("POST")
            .uri(path)
            .header("content-type", "application/json");
        let builder = if auth {
            builder.header("authorization", format!("Bearer {token}"))
        } else {
            builder
        };
        builder.body(Body::from(body)).unwrap()
    };
    let response = app
        .clone()
        .oneshot(request(
            "/v1/accounts/one/moments/upload-image",
            body.clone(),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(
        response.status(),
        StatusCode::OK,
        "route accepts >128KiB before image validation"
    );
    let json: Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(json["ok"], false);
    assert_eq!(json["accountId"], "one");
    let response = app
        .clone()
        .oneshot(request(
            "/v1/accounts/one/moments/upload-image",
            body.clone(),
            false,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let response = app
        .clone()
        .oneshot(request("/v1/accounts/one/moments/probe", body, true))
        .await
        .unwrap();
    assert_eq!(
        response.status(),
        StatusCode::PAYLOAD_TOO_LARGE,
        "existing routes retain their limit"
    );
    let response = app
        .oneshot(request(
            "/v1/accounts/one/moments/upload-image",
            " ".repeat(2 * 1024 * 1024 + 1),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
}
