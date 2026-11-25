//! Lets pages in the app's web view capture the mouse pointer (the Pointer Lock API), which games in
//! Play here use for mouse look. WebKit asks the web view's UI delegate before it grants a lock, and
//! refuses when the delegate has no answer; wry's delegate has none, so this gives it one.
//! By the time WebKit asks, it has checked that the request comes from a click, in a frame allowed to
//! lock the pointer (Play here's frame is sandboxed with allow-pointer-lock), in the focused, visible
//! window. Esc always gives the pointer back.

#[cfg(target_os = "macos")]
pub fn allow(window: &tauri::WebviewWindow) {
    let _ = window.with_webview(|pv| platform::allow(pv.inner()));
}

#[cfg(not(target_os = "macos"))]
pub fn allow(_window: &tauri::WebviewWindow) {}

#[cfg(target_os = "macos")]
mod platform {
    use block2::Block;
    use objc2::ffi::class_addMethod;
    use objc2::runtime::{AnyClass, AnyObject, Bool, Imp, Sel};
    use objc2::sel;
    use objc2_web_kit::WKWebView;

    /// `-[id<WKUIDelegatePrivate> _webViewDidRequestPointerLock:completionHandler:]`: yes.
    unsafe extern "C-unwind" fn did_request(_this: *mut AnyObject, _cmd: Sel, _web_view: *mut AnyObject, decide: *mut Block<dyn Fn(Bool)>) {
        if let Some(decide) = unsafe { decide.as_ref() } {
            decide.call((Bool::YES,));
        }
    }

    /// `-[id<WKUIDelegatePrivate> _webViewDidLosePointerLock:]`: nothing to do.
    unsafe extern "C-unwind" fn did_lose(_this: *mut AnyObject, _cmd: Sel, _web_view: *mut AnyObject) {}

    pub fn allow(web_view: *mut std::ffi::c_void) {
        if web_view.is_null() {
            return;
        }
        // SAFETY: Tauri passes its live WKWebView on the main thread. class_addMethod only adds methods
        // the delegate's class lacks (it never replaces one), with matching type encodings.
        unsafe {
            let web = &*(web_view as *const WKWebView);
            let Some(delegate) = web.UIDelegate() else { return };
            let object: &AnyObject = delegate.as_ref();
            let class = object.class() as *const AnyClass as *mut AnyClass;
            let request: unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject, *mut Block<dyn Fn(Bool)>) = did_request;
            let lose: unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) = did_lose;
            class_addMethod(class, sel!(_webViewDidRequestPointerLock:completionHandler:), std::mem::transmute::<_, Imp>(request), c"v@:@@?".as_ptr());
            class_addMethod(class, sel!(_webViewDidLosePointerLock:), std::mem::transmute::<_, Imp>(lose), c"v@:@".as_ptr());
            // WebKit notes which methods its delegate has when the delegate is set, so set it again.
            web.setUIDelegate(None);
            web.setUIDelegate(Some(&delegate));
        }
    }
}
