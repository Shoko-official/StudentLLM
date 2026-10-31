//! Keeps the webview on the application. A Content Security Policy does not cover top-level
//! navigation, so script that ran in the webview could otherwise send data to any host with
//! `location.href = "https://host/?d=..."`. Only the app's own origins are allowed.

use tauri::Url;

/// The Vite development server started by `tauri dev` (see `build.devUrl`).
const DEV_SERVER_PORT: u16 = 1420;

fn is_app_origin(url: &Url) -> bool {
    match url.scheme() {
        // macOS and Linux serve the bundled frontend from tauri://localhost.
        "tauri" => url.host_str() == Some("localhost") && url.port().is_none(),
        // Windows serves it from http://tauri.localhost (https with `useHttpsScheme`).
        "http" | "https" => {
            url.host_str() == Some("tauri.localhost") && url.port().is_none() && url.username().is_empty()
        }
        _ => false,
    }
}

fn is_dev_server(url: &Url) -> bool {
    cfg!(debug_assertions)
        && url.scheme() == "http"
        && matches!(url.host_str(), Some("127.0.0.1") | Some("localhost"))
        && url.port() == Some(DEV_SERVER_PORT)
        && url.username().is_empty()
}

/// `blob:` URLs the app made for its source previews. Most engines write the creating origin into
/// the URL (`blob:http://tauri.localhost/<uuid>`); WebKit may write `null` for a custom scheme
/// (`blob:null/<uuid>`). A blob only holds content created in this webview, and a navigation that
/// leaves it for another URL is checked again.
fn is_local_blob(url: &Url) -> bool {
    let path = url.path();
    if let Some(id) = path.strip_prefix("null/") {
        return id.len() >= 8 && id.bytes().all(|byte| byte.is_ascii_hexdigit() || byte == b'-');
    }
    Url::parse(path)
        .map(|inner| inner.scheme() != "blob" && (is_app_origin(&inner) || is_dev_server(&inner)))
        .unwrap_or(false)
}

/// Decides whether the webview may navigate to `url`.
///
/// Allowed: the bundled app origins, the development server in debug builds, `about:blank`, and
/// `blob:` URLs created by the app itself (the source previews).
pub fn is_allowed_navigation(url: &Url) -> bool {
    if url.as_str() == "about:blank" {
        return true;
    }
    if url.scheme() == "blob" {
        return is_local_blob(url);
    }
    is_app_origin(url) || is_dev_server(url)
}

/// A plugin whose only job is to veto navigation away from the app. Tauri consults plugin
/// navigation hooks for windows created from `tauri.conf.json` as well.
pub fn plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::<R>::new("studentllm-navigation")
        .on_navigation(|_webview, url| {
            let allowed = is_allowed_navigation(url);
            if !allowed {
                // Scheme and host only: the rest of the URL may carry data.
                eprintln!(
                    "Blocked navigation to {}://{}",
                    url.scheme(),
                    url.host_str().unwrap_or("")
                );
            }
            allowed
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn allowed(value: &str) -> bool {
        is_allowed_navigation(&Url::parse(value).expect("test URL parses"))
    }

    #[test]
    fn allows_the_bundled_app_origins() {
        assert!(allowed("tauri://localhost"));
        assert!(allowed("tauri://localhost/index.html"));
        assert!(allowed("http://tauri.localhost/"));
        assert!(allowed("https://tauri.localhost/#/course"));
        assert!(allowed("about:blank"));
    }

    #[test]
    fn allows_blob_previews_created_by_the_app_only() {
        assert!(allowed("blob:http://tauri.localhost/5f1c0d7e-0000-4000-8000-000000000000"));
        assert!(allowed("blob:tauri://localhost/5f1c0d7e-0000-4000-8000-000000000000"));
        assert!(!allowed("blob:https://example.com/5f1c0d7e-0000-4000-8000-000000000000"));
        assert!(!allowed("blob:blob:http://tauri.localhost/x"));
        assert!(!allowed("blob:not a url"));
    }

    #[test]
    fn allows_the_opaque_blob_origin_webkit_may_produce() {
        assert!(allowed("blob:null/5f1c0d7e-0000-4000-8000-000000000000"));
        assert!(allowed("blob:null/5F1C0D7E00004000800000000000000A"));
        assert!(!allowed("blob:null/"));
        assert!(!allowed("blob:null/short"));
        assert!(!allowed("blob:null/5f1c0d7e/../secret"));
        assert!(!allowed("blob:null/5f1c0d7e-0000-4000-8000-000000000000/extra"));
        assert!(!allowed("blob:nullx/5f1c0d7e-0000-4000-8000-000000000000"));
    }

    #[test]
    fn denies_external_hosts_and_look_alikes() {
        assert!(!allowed("https://example.com/?d=secret"));
        assert!(!allowed("http://tauri.localhost.example.com/"));
        assert!(!allowed("http://tauri.localhost:8080/"));
        assert!(!allowed("https://tauri.localhost@example.com/"));
        assert!(!allowed("http://user@tauri.localhost/"));
        assert!(!allowed("tauri://example.com/"));
        assert!(!allowed("tauri://localhost:9999/"));
        assert!(!allowed("http://127.0.0.1:1234/v1"));
        assert!(!allowed("http://localhost:8766/"));
    }

    #[test]
    fn denies_other_schemes() {
        assert!(!allowed("file:///etc/passwd"));
        assert!(!allowed("data:text/html,<script>1</script>"));
        assert!(!allowed("javascript:alert(1)"));
        assert!(!allowed("ftp://tauri.localhost/"));
        assert!(!allowed("about:srcdoc"));
    }

    // Pins the shipped behaviour. It only exists without debug assertions; CI runs it with
    // CARGO_PROFILE_TEST_DEBUG_ASSERTIONS=false (see the quality job).
    #[cfg(not(debug_assertions))]
    #[test]
    fn denies_the_dev_server_without_debug_assertions() {
        assert!(!allowed("http://127.0.0.1:1420/"));
        assert!(!allowed("http://localhost:1420/"));
        assert!(!allowed("blob:http://127.0.0.1:1420/5f1c0d7e-0000-4000-8000-000000000000"));
    }

    #[test]
    fn allows_the_development_server_only_in_debug_builds() {
        assert_eq!(allowed("http://127.0.0.1:1420/"), cfg!(debug_assertions));
        assert_eq!(allowed("http://localhost:1420/"), cfg!(debug_assertions));
        assert!(!allowed("http://127.0.0.1:1421/"));
        assert!(!allowed("https://127.0.0.1:1420/"));
    }
}
