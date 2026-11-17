use super::*;
pub(super) fn routes() -> Router<App> {
    Router::new()
        .route(
            "/v1/accounts/{a}/settings",
            get(account_settings).patch(update_settings),
        )
        .route(
            "/v1/accounts/{a}/messages/{id}/recall",
            post(recall_message),
        )
        .route("/v1/accounts/{a}/capabilities", get(capabilities))
        .route("/v1/accounts/{a}/pats/capability", get(pat_capability))
        .route("/v1/accounts/{a}/pats/by-idempotency-key", get(pat_by_key))
        .route(
            "/v1/accounts/{a}/pats",
            post(send_pat).layer(DefaultBodyLimit::max(1024)),
        )
        .route("/v1/accounts/{a}/connect", post(connect))
        .route("/v1/accounts/{a}/disconnect", post(disconnect))
        .route("/v1/accounts/{a}/logout", post(logout))
        .route("/v1/accounts/{a}/forget-credentials", post(forget))
        .route("/v1/accounts/{a}/login-attempts", post(login))
        .route(
            "/v1/accounts/{a}/login-attempts/{id}",
            get(operation).delete(cancel),
        )
        .route("/v1/accounts/{a}/login-attempts/{id}/qr", get(qr))
        .route("/v1/accounts/{a}/login-attempts/{id}/cancel", post(cancel))
        .route(
            "/v1/accounts/{a}/sends/by-idempotency-key",
            get(send_by_key),
        )
        .route("/v1/accounts/{a}/sends/{id}/cancel", post(cancel_send))
        .route("/v1/accounts/{a}/threads/{id}", get(thread))
        .route("/v1/accounts/{a}/contacts/{id}", get(contact))
        .route("/v1/accounts/{a}/groups/{id}", get(group))
        .route(
            "/v1/accounts/{a}/contacts/{id}/refresh",
            post(refresh_contact),
        )
        .route("/v1/accounts/{a}/groups/{id}/refresh", post(refresh_group))
        .route(
            "/v1/accounts/{a}/groups/{id}/members/refresh",
            post(refresh_members),
        )
        .route(
            "/v1/accounts/{a}/avatars/{id}/refresh",
            post(refresh_avatar),
        )
        .route("/v1/accounts/{a}/contact-sync", post(sync_contacts))
        .route("/v1/accounts/{a}/group-sync", post(sync_groups))
        .route(
            "/v1/accounts/{a}/moments/upload-image",
            post(moments_upload_image).layer(DefaultBodyLimit::max(2 * 1024 * 1024)),
        )
        .route(
            "/v1/accounts/{a}/moments/download-image",
            post(moments_download_image).layer(DefaultBodyLimit::max(1024)),
        )
}

async fn pat_capability(
    State(app): State<App>,
    Extension(c): Extension<Claims>,
    Path(a): Path<String>,
) -> ApiResult<Json<Value>> {
    c.require(Some(&a), "read")?;
    app.core.account_status(&a)?;
    Ok(Json(
        json!({"accountId":a,"nativePat":app.core.upstream_kind() == wechat_core::upstream::UpstreamKind::Native,
        "verified":false,"protocol":"sendpat-849","groupOnly":true}),
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PatSendRequest {
    group_id: String,
    target_user_id: String,
    client_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PatLookup {
    key: String,
}

async fn pat_by_key(
    State(app): State<App>,
    Extension(c): Extension<Claims>,
    Path(a): Path<String>,
    Query(input): Query<PatLookup>,
) -> ApiResult<Json<Value>> {
    c.require(Some(&a), "read")?;
    app.core
        .pat_by_client_id(&a, &input.key)?
        .map(Json)
        .ok_or(ApiError(StatusCode::NOT_FOUND, "pat_operation_not_found"))
}

async fn send_pat(
    State(app): State<App>,
    Extension(c): Extension<Claims>,
    Path(a): Path<String>,
    headers: HeaderMap,
    Json(input): Json<PatSendRequest>,
) -> ApiResult<Json<Value>> {
    c.require(Some(&a), "send")?;
    let key = idempotency_key(&headers)?;
    if key != input.client_id || input.group_id.len() > 128 || input.target_user_id.len() > 128 {
        return Err(ApiError(StatusCode::BAD_REQUEST, "invalid_pat_request"));
    }
    Ok(Json(
        app.core
            .send_pat_once(&a, &input.group_id, &input.target_user_id, key)
            .await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MomentsImageDownloadRequest {
    moment_id: String,
    media_id: String,
}

async fn moments_download_image(
    State(app): State<App>,
    Extension(c): Extension<Claims>,
    Path(a): Path<String>,
    input: std::result::Result<
        Json<MomentsImageDownloadRequest>,
        axum::extract::rejection::JsonRejection,
    >,
) -> ApiResult<Json<Value>> {
    c.require(Some(&a), "read")?;
    let Json(input) =
        input.map_err(|failure| ApiError(failure.status(), "moments_image_invalid_request"))?;
    app.core
        .moments_download_image(&a, &input.moment_id, &input.media_id)
        .await
        .map(Json)
        .map_err(|error| {
            use wechat_core::MomentsImageDownloadError as Error;
            let status = match error {
                Error::InvalidId => StatusCode::BAD_REQUEST,
                Error::AccountUnavailable => StatusCode::NOT_FOUND,
                Error::UnsupportedRuntime => StatusCode::NOT_IMPLEMENTED,
                Error::AuthenticationRequired => StatusCode::CONFLICT,
                Error::IdentityRejected => StatusCode::UNPROCESSABLE_ENTITY,
                Error::DetailUnavailable | Error::DownloadFailed => StatusCode::BAD_GATEWAY,
                Error::StateUnavailable | Error::WorkerUnavailable => {
                    StatusCode::SERVICE_UNAVAILABLE
                }
            };
            ApiError(status, error.code())
        })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MomentsImageRequest {
    image_base64: String,
    sha256: String,
}

async fn moments_upload_image(
    State(app): State<App>,
    Extension(c): Extension<Claims>,
    Path(a): Path<String>,
    Json(input): Json<MomentsImageRequest>,
) -> ApiResult<Json<Value>> {
    c.require(Some(&a), "admin")?;
    match app
        .core
        .moments_upload_image(&a, &input.image_base64, &input.sha256)
        .await
    {
        Ok(value) => Ok(Json(value)),
        // Include only the top-level bounded status. Never serialize the
        // credential-bearing CDN config, request fields, or source image.
        Err(error) => Ok(Json(json!({
            "ok": false,
            "accountId": a,
            "code": "moments_image_upload_failed",
            "detail": error.to_string().chars().take(240).collect::<String>()
        }))),
    }
}
async fn recall_message(
    State(app): State<App>,
    Extension(c): Extension<Claims>,
    Path((a, id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(input): Json<contracts::NativeRecallRequest>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    c.require(Some(&a), "send")?;
    let key = idempotency_key(&headers)?;
    if input
        .server_id
        .parse::<u64>()
        .ok()
        .filter(|value| *value > 0)
        .is_none_or(|value| value.to_string() != input.server_id)
    {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "invalid_recall_server_id",
        ));
    }
    let operation = app
        .core
        .recall_message(&a, &id, &input.server_id, key)
        .await?;
    Ok((
        StatusCode::ACCEPTED,
        checked::<contracts::NativeOperation>(
            serde_json::to_value(operation).map_err(anyhow::Error::from)?,
        )?,
    ))
}
/// Diagnostic transport for read-only Moments endpoints. The request body is
/// supplied verbatim because the official schema is still being validated; the
/// protocol layer accepts only read cgis and bounds both directions.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct MomentsProbeRequest {
    pub cgi: u16,
    pub body_hex: String,
    #[serde(default)]
    pub with_base_request: bool,
    #[serde(default)]
    pub write: bool,
}
pub(super) async fn moments_probe(
    State(app): State<App>,
    Extension(c): Extension<Claims>,
    Path(a): Path<String>,
    Json(input): Json<MomentsProbeRequest>,
) -> ApiResult<Json<Value>> {
    c.require(Some(&a), "admin")?;
    // Diagnostic route: return the error chain, truncated, instead of the
    // generic `operation_failed`. The schema is being discovered, so the cause
    // (transport vs. gate vs. server code) is the only useful output.
    match app
        .core
        .moments_probe(
            &a,
            input.cgi,
            &input.body_hex,
            input.with_base_request,
            input.write,
        )
        .await
    {
        Ok(value) => Ok(Json(value)),
        Err(error) => {
            let detail = format!("{error:#}");
            let detail: String = detail.chars().take(500).collect();
            Ok(Json(json!({"ok": false, "detail": detail})))
        }
    }
}
async fn account_settings(
    State(app): State<App>,
    Extension(c): Extension<Claims>,
    Path(a): Path<String>,
) -> ApiResult<Json<wechat_store::AccountSettings>> {
    c.require(Some(&a), "read")?;
    Ok(Json(app.core.store.account_settings(&a)?))
}
async fn update_settings(
    State(app): State<App>,
    Extension(c): Extension<Claims>,
    Path(a): Path<String>,
    Json(input): Json<wechat_store::AccountSettings>,
) -> ApiResult<Json<wechat_store::AccountSettings>> {
    c.require(Some(&a), "media")?;
    let _guard = app.core.lock_account(&a).await?;
    app.core.store.set_account_settings(&a, &input)?;
    app.core.store.append_event(
        &a,
        "account.settings_updated",
        &json!({"accountId":a,"settings":input}),
    )?;
    Ok(Json(app.core.store.account_settings(&a)?))
}
pub(super) async fn update_account(
    State(app): State<App>,
    Extension(c): Extension<Claims>,
    Path(a): Path<String>,
    Json(input): Json<UpdateAccount>,
) -> ApiResult<Json<Value>> {
    c.require(Some(&a), "admin")?;
    if let Some(alias) = input.alias {
        app.core.store.set_account_alias(&a, &alias)?;
    }
    if let Some(enabled) = input.auto_connect {
        app.core
            .store
            .put_runtime(&a, "auto-connect", if enabled { b"1" } else { b"0" })?;
    }
    Ok(Json(app.core.account_status(&a)?))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct UpdateAccount {
    alias: Option<String>,
    auto_connect: Option<bool>,
}
async fn capabilities(
    State(app): State<App>,
    Extension(c): Extension<Claims>,
    Path(a): Path<String>,
) -> ApiResult<Json<Value>> {
    c.require(Some(&a), "read")?;
    app.core.store.account(&a)?;
    if app.core.upstream_kind() == wechat_core::upstream::UpstreamKind::Simulator {
        return Ok(Json(
            json!({"nativeRuntime":true,"upstream":"simulator","officialBinaryRequired":false,"textMentions":true,"inlineTextMentions":true,"quotedTextSend":true,"quotedTextSendScopes":["read","send"],"quotedTextSendLiveValidated":false,"mediaUploadMaxBytes":wechat_core::MediaKind::Image.max_source_bytes(),"mediaSendMaxBytes":{"file":wechat_core::MediaKind::Image.max_source_bytes(),"image":wechat_core::MediaKind::Image.max_source_bytes(),"voice":wechat_core::MediaKind::Image.max_source_bytes(),"video":wechat_core::MediaKind::Image.max_source_bytes()},"groupMutations":["create","rename","leave","add_members","remove_members","my_name","clear_announcement"],"groupMutationScope":"admin","groupCreateMinSelectedMembers":2,"groupMutationMaxSelectedMembers":40,"threadNotificationTargets":["direct","group"],"threadPinningTargets":["direct","group"],"threadPinningScope":"admin","incomingGroupUpdates":"partial","mediaKinds":["image","file","video","voice"],"downloadQualities":["best","thumbnail","standard","original","normal","encoded"],"logout":true,"savedDeviceLogin":true,"profileKeysConfigured":app.core.store.keys_file(&a)?.is_some()}),
        ));
    }
    Ok(Json(
        json!({"nativeRuntime":true,"officialBinaryRequired":false,"textMentions":true,"inlineTextMentions":true,"quotedTextSend":true,"quotedTextSendScopes":["read","send"],"quotedTextSendLiveValidated":false,"mediaUploadMaxBytes":wechat_core::MAX_SOURCE_BYTES,"mediaSendMaxBytes":media_send_max_bytes(),"mediaKinds":["image","file","video","voice"],"downloadQualities":["best","thumbnail","standard","original","normal","encoded"],"logout":true,"savedDeviceLogin":true,"profileKeysConfigured":app.core.store.keys_file(&a)?.is_some(),"groupMutations":["create","rename","leave","add_members","remove_members","my_name","clear_announcement"],"groupMutationScope":"admin","groupCreateMinSelectedMembers":2,"groupMutationMaxSelectedMembers":40,"threadNotificationTargets":["direct","group"],"threadPinningTargets":["direct","group"],"threadPinningScope":"admin","incomingGroupUpdates":"partial"}),
    ))
}
fn media_send_max_bytes() -> Value {
    use wechat_core::MediaKind;
    json!({
        "file": MediaKind::File.max_source_bytes(),
        "image": MediaKind::Image.max_source_bytes(),
        "video": MediaKind::Video.max_source_bytes(),
        "voice": MediaKind::Voice.max_source_bytes(),
    })
}
async fn connect(
    State(app): State<App>,
    Extension(c): Extension<Claims>,
    Path(a): Path<String>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    c.require(Some(&a), "login")?;
    Ok((
        StatusCode::ACCEPTED,
        Json(serde_json::to_value(app.core.connect(&a).await?).map_err(anyhow::Error::from)?),
    ))
}
async fn logout(
    State(app): State<App>,
    Extension(c): Extension<Claims>,
    Path(a): Path<String>,
    headers: HeaderMap,
) -> ApiResult<(StatusCode, Json<Value>)> {
    c.require(Some(&a), "login")?;
    let key = idempotency_key(&headers)?;
    Ok((
        StatusCode::ACCEPTED,
        Json(serde_json::to_value(app.core.logout(&a, key).await?).map_err(anyhow::Error::from)?),
    ))
}
async fn forget(
    State(app): State<App>,
    Extension(c): Extension<Claims>,
    Path(a): Path<String>,
    headers: HeaderMap,
    Json(input): Json<contracts::NativeForgetRequest>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    c.require(Some(&a), "login")?;
    if !input.confirm {
        return Err(ApiError(StatusCode::BAD_REQUEST, "confirmation_required"));
    }
    let key = idempotency_key(&headers)?;
    Ok((
        StatusCode::ACCEPTED,
        Json(
            serde_json::to_value(app.core.forget_credentials(&a, key).await?)
                .map_err(anyhow::Error::from)?,
        ),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SendKey {
    key: String,
}
async fn send_by_key(
    State(app): State<App>,
    Extension(c): Extension<Claims>,
    Path(a): Path<String>,
    Query(q): Query<SendKey>,
) -> ApiResult<Json<Value>> {
    c.require(Some(&a), "send")?;
    if q.key.is_empty() || q.key.len() > 200 {
        return Err(ApiError(StatusCode::BAD_REQUEST, "invalid_idempotency_key"));
    }
    let result = match app.core.store.send_by_key(&a, &q.key) {
        Ok(send) => serde_json::to_value(send),
        Err(_) => serde_json::to_value(app.core.media_job_by_key(&a, &q.key)?),
    };
    Ok(Json(result.map_err(anyhow::Error::from)?))
}
async fn cancel_send(
    State(app): State<App>,
    Extension(c): Extension<Claims>,
    Path((a, id)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    c.require(Some(&a), "send")?;
    let result = match app.core.store.send(&a, &id) {
        Ok(_) => serde_json::to_value(app.core.store.cancel_send(&a, &id)?),
        Err(_) => serde_json::to_value(app.core.cancel_media_job(&a, &id)?),
    };
    Ok(Json(result.map_err(anyhow::Error::from)?))
}
async fn exact(
    app: App,
    c: Claims,
    a: String,
    id: String,
    kind: &'static str,
) -> ApiResult<Json<Value>> {
    c.require(Some(&a), "read")?;
    let value = app
        .core
        .read(&a.clone(), move |core| {
            if kind == "groups" {
                core.group_info(&a, &id)
            } else {
                core.catalog_item(&a, kind, &id)
            }
        })
        .await
        .map_err(ApiError::from)?;
    match kind {
        "threads" => checked::<contracts::NativeThread>(value),
        "contacts" => checked::<contracts::NativeContact>(value),
        "groups" => checked::<contracts::NativeGroup>(value),
        _ => Err(ApiError(StatusCode::BAD_REQUEST, "invalid_request")),
    }
}
async fn thread(
    State(app): State<App>,
    Extension(c): Extension<Claims>,
    Path((a, id)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    exact(app, c, a, id, "threads").await
}
async fn contact(
    State(app): State<App>,
    Extension(c): Extension<Claims>,
    Path((a, id)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    exact(app, c, a, id, "contacts").await
}
async fn group(
    State(app): State<App>,
    Extension(c): Extension<Claims>,
    Path((a, id)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    exact(app, c, a, id, "groups").await
}
fn metadata(
    app: App,
    c: Claims,
    a: String,
    action: wechat_core::MetadataAction,
) -> ApiResult<(StatusCode, Json<Value>)> {
    c.require(Some(&a), "read")?;
    Ok((
        StatusCode::ACCEPTED,
        Json(
            serde_json::to_value(app.core.start_metadata(&a, action)?)
                .map_err(anyhow::Error::from)?,
        ),
    ))
}
async fn refresh_contact(
    State(app): State<App>,
    Extension(c): Extension<Claims>,
    Path((a, id)): Path<(String, String)>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    metadata(
        app,
        c,
        a,
        wechat_core::MetadataAction::Contact { contact_id: id },
    )
}
async fn refresh_group(
    State(app): State<App>,
    Extension(c): Extension<Claims>,
    Path((a, id)): Path<(String, String)>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    metadata(
        app,
        c,
        a,
        wechat_core::MetadataAction::Group { group_id: id },
    )
}
async fn refresh_members(
    State(app): State<App>,
    Extension(c): Extension<Claims>,
    Path((a, id)): Path<(String, String)>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    metadata(
        app,
        c,
        a,
        wechat_core::MetadataAction::Members {
            group_id: id,
            version: 0,
        },
    )
}
async fn refresh_avatar(
    State(app): State<App>,
    Extension(c): Extension<Claims>,
    Path((a, id)): Path<(String, String)>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    c.require(Some(&a), "media")?;
    metadata(
        app,
        c,
        a,
        wechat_core::MetadataAction::Avatar { contact_id: id },
    )
}
async fn sync_contacts(
    State(app): State<App>,
    Extension(c): Extension<Claims>,
    Path(a): Path<String>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    metadata(
        app,
        c,
        a,
        wechat_core::MetadataAction::ContactSync { max_pages: 10 },
    )
}
async fn sync_groups(
    State(app): State<App>,
    Extension(c): Extension<Claims>,
    Path(a): Path<String>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    metadata(
        app,
        c,
        a,
        wechat_core::MetadataAction::GroupSync { max_pages: 10 },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    #[tokio::test]
    async fn capabilities_distinguish_staging_from_each_send_kind() {
        let temp = tempfile::tempdir().unwrap();
        let store = Arc::new(Store::open(&temp.path().join("data")).unwrap());
        store.create_account("one").unwrap();
        let core = Core::new(store, None).unwrap();
        let token = "0123456789abcdef0123456789abcdef";
        let app = crate::router(core, token);
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/v1/accounts/one/capabilities")
                    .header("authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value =
            serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(body["mediaUploadMaxBytes"], 536_870_912);
        assert_eq!(body["quotedTextSend"], true);
        assert_eq!(body["quotedTextSendScopes"], json!(["read", "send"]));
        assert_eq!(body["quotedTextSendLiveValidated"], false);
        assert_eq!(body["textMentions"], true);
        assert_eq!(body["inlineTextMentions"], true);
        assert_eq!(body["mediaSendMaxBytes"]["file"], 536_870_912);
        assert_eq!(body["mediaSendMaxBytes"]["video"], 52_428_800);
        for kind in ["image", "voice"] {
            assert_eq!(body["mediaSendMaxBytes"][kind], 26_214_383);
        }
        assert!(body["mediaSendMaxBytes"].get("sticker").is_none());
    }
}
