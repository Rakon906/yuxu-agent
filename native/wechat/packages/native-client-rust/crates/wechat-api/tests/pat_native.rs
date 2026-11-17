use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use tower::ServiceExt;

#[tokio::test]
async fn pat_http_requires_auth_key_match_and_bounded_body() {
    let temp = tempfile::tempdir().unwrap();
    let store = std::sync::Arc::new(wechat_store::Store::open(&temp.path().join("data")).unwrap());
    store.create_account("one").unwrap();
    let token = "0123456789abcdef0123456789abcdef";
    let app = wechat_api::router(wechat_core::Core::new(store, None).unwrap(), token);
    for (auth, key, body, status) in [
        (
            false,
            "a",
            r#"{"groupId":"123@chatroom","targetUserId":"wxid_peer","clientId":"a"}"#.to_string(),
            StatusCode::UNAUTHORIZED,
        ),
        (
            true,
            "b",
            r#"{"groupId":"123@chatroom","targetUserId":"wxid_peer","clientId":"a"}"#.to_string(),
            StatusCode::BAD_REQUEST,
        ),
        (true, "a", " ".repeat(1025), StatusCode::PAYLOAD_TOO_LARGE),
    ] {
        let mut req = Request::builder()
            .method("POST")
            .uri("/v1/accounts/one/pats")
            .header("content-type", "application/json")
            .header("idempotency-key", key);
        if auth {
            req = req.header("authorization", format!("Bearer {token}"));
        }
        assert_eq!(
            app.clone()
                .oneshot(req.body(Body::from(body)).unwrap())
                .await
                .unwrap()
                .status(),
            status
        );
    }
    let lookup = Request::builder()
        .uri("/v1/accounts/one/pats/by-idempotency-key?key=not-found")
        .header("authorization", format!("Bearer {token}"))
        .body(Body::empty())
        .unwrap();
    assert_eq!(
        app.clone().oneshot(lookup).await.unwrap().status(),
        StatusCode::NOT_FOUND
    );
    let no_auth = Request::builder()
        .uri("/v1/accounts/one/pats/by-idempotency-key?key=not-found")
        .body(Body::empty())
        .unwrap();
    assert_eq!(
        app.clone().oneshot(no_auth).await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
}
