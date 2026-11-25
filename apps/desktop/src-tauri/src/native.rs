//! Self-test only: native input and snapshots for the app's own web view.
//!
//! The real-app self-test drives the UI from inside the page, which can only make untrusted DOM events.
//! These helpers make the events AppKit makes for a mouse, a trackpad (scrolls and pinches) and the
//! keyboard, and hand them to the WKWebView, so WebKit's own event handling runs: the page receives
//! trusted pointer, wheel, gesture and key events, as it does for a person. The commands that use this
//! module (smoke_input, smoke_snapshot, smoke_windows) refuse to run outside --smoke-test mode.

use crate::error::{AppError, AppResult};
use serde::Deserialize;
use std::sync::atomic::{AtomicIsize, Ordering};
use std::time::Duration;

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum InputStep {
    /// Left button pressed, dragged to or released at a point in the page (CSS pixels, top-left origin).
    Down { x: f64, y: f64 },
    Drag { x: f64, y: f64 },
    Up { x: f64, y: f64 },
    /// A two-finger trackpad scroll; `dy` is the page's wheel deltaY (positive scrolls down).
    Scroll { x: f64, y: f64, dy: i32 },
    /// One step of a trackpad pinch: "began", "changed" (0.1 = 10% larger) or "ended".
    Pinch { x: f64, y: f64, magnification: f64, phase: String },
    /// A key press or release. `code` is the macOS virtual key code (13 is W, 53 is Esc).
    Key { key: String, code: u16, down: bool },
    /// The mouse moving by (dx, dy) with no button held: what a page that captured the pointer sees as
    /// movementX/movementY.
    Move { x: f64, y: f64, dx: i64, dy: i64 },
    /// Brings the window to the front and gives it the keyboard, as clicking on it would. WebKit lets a
    /// page capture the pointer only in the focused window.
    Focus,
    Wait { ms: u64 },
}

static EVENT_NUMBER: AtomicIsize = AtomicIsize::new(1);

/// Sends the steps one at a time, about a frame apart, and returns a note per event sent.
pub async fn send_steps(window: &tauri::WebviewWindow, steps: Vec<InputStep>) -> AppResult<Vec<String>> {
    let mut notes = Vec::with_capacity(steps.len());
    for step in steps {
        if let InputStep::Wait { ms } = step {
            tokio::time::sleep(Duration::from_millis(ms.min(10_000))).await;
            continue;
        }
        if let InputStep::Focus = step {
            window.set_focus().map_err(|e| AppError::Unavailable(format!("The window could not take focus: {e}")))?;
            tokio::time::sleep(Duration::from_millis(300)).await;
            notes.push("focus".into());
            continue;
        }
        let number = EVENT_NUMBER.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = tokio::sync::oneshot::channel();
        window
            .with_webview(move |pv| {
                let _ = tx.send(platform::send(&pv, &step, number));
            })
            .map_err(|e| AppError::Unavailable(format!("No web view to send input to: {e}")))?;
        let note = rx.await.map_err(|_| AppError::Unavailable("The window closed during the input".into()))?.map_err(AppError::Unavailable)?;
        notes.push(note);
        tokio::time::sleep(Duration::from_millis(16)).await;
    }
    Ok(notes)
}

/// Seconds since a person last used the mouse, trackpad or keyboard. Input this module sends is not
/// counted: it goes to the web view, not through the HID system.
pub fn seconds_since_person_input() -> f64 {
    platform::seconds_since_person_input()
}

/// A PNG of the web view as it is on screen, WebGL canvases and embedded frames included.
pub async fn snapshot(window: &tauri::WebviewWindow) -> AppResult<Vec<u8>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    window
        .with_webview(move |pv| platform::snapshot(&pv, Box::new(move |r| drop(tx.send(r)))))
        .map_err(|e| AppError::Unavailable(format!("No web view to capture: {e}")))?;
    tokio::time::timeout(Duration::from_secs(15), rx)
        .await
        .map_err(|_| AppError::Unavailable("The snapshot timed out".into()))?
        .map_err(|_| AppError::Unavailable("The window closed during the snapshot".into()))?
        .map_err(AppError::Unavailable)
}

/// A window on screen: the app that owns it, its process, its layer (0 for ordinary windows) and its size
/// in points. macOS lists these without the Screen Recording permission; titles need it and are not read.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenWindow {
    pub owner: String,
    pub pid: i64,
    pub layer: i64,
    pub width: f64,
    pub height: f64,
}

/// The windows on screen, front to back. The self-test uses it to see that an editor the Play view opened
/// shows a window.
pub fn windows_on_screen() -> Vec<ScreenWindow> {
    platform::windows_on_screen()
}

#[cfg(target_os = "macos")]
mod platform {
    use super::InputStep;
    use block2::RcBlock;
    use objc2::msg_send;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSEvent, NSEventModifierFlags, NSEventType, NSImage, NSScreen, NSTrackingAreaOptions, NSView, NSWindow};
    use objc2_core_foundation::CGPoint;
    use objc2_core_graphics::{CGEvent, CGEventField, CGEventSource, CGEventSourceStateID, CGEventType, CGMouseButton, CGScrollEventUnit};
    use objc2_foundation::{MainThreadMarker, NSDictionary, NSError, NSPoint, NSProcessInfo, NSString};
    use objc2_web_kit::WKWebView;
    use std::cell::RefCell;

    // AppKit turns a Core Graphics gesture event (type 29) whose HID type is 8 (zoom) into a magnify
    // NSEvent: what a trackpad pinch produces. These fields are not in the public headers; the self-test
    // checks that the event really comes out as a pinch before sending it.
    const GESTURE_EVENT: u32 = 29;
    const FIELD_GESTURE_HID_TYPE: u32 = 110;
    const FIELD_GESTURE_ZOOM_VALUE: u32 = 113;
    const FIELD_GESTURE_PHASE: u32 = 132;
    const HID_ZOOM: i64 = 8;

    struct Target<'a> {
        view: &'a NSView,
        window: &'a NSWindow,
        mtm: MainThreadMarker,
    }

    impl Target<'_> {
        /// A page point (CSS pixels from the top left) in the window's coordinates.
        fn window_point(&self, x: f64, y: f64) -> NSPoint {
            let local = if self.view.isFlipped() { NSPoint::new(x, y) } else { NSPoint::new(x, self.view.bounds().size.height - y) };
            self.view.convertPoint_toView(local, None)
        }

        /// Where to put a Core Graphics event. An NSEvent made from one has no window, so its
        /// locationInWindow is the event's screen position (bottom-left origin), and WebKit reads that as
        /// window coordinates: place the event where the two agree.
        fn cg_location(&self, x: f64, y: f64) -> CGPoint {
            let w = self.window_point(x, y);
            let height = NSScreen::screens(self.mtm).firstObject().map(|s| s.frame().size.height).unwrap_or(0.0);
            CGPoint { x: w.x, y: height - w.y }
        }
    }

    pub fn windows_on_screen() -> Vec<super::ScreenWindow> {
        use objc2::rc::Retained;
        use objc2::runtime::AnyObject;
        use objc2_core_graphics::{kCGNullWindowID, CGWindowListCopyWindowInfo, CGWindowListOption};
        let Some(list) = CGWindowListCopyWindowInfo(CGWindowListOption::OptionOnScreenOnly | CGWindowListOption::ExcludeDesktopElements, kCGNullWindowID) else {
            return Vec::new();
        };
        // CFArray, CFDictionary, CFString and CFNumber are toll-free bridged to NSArray, NSDictionary, NSString
        // and NSNumber, so Foundation's methods read them.
        let array: &AnyObject = unsafe { &*(&*list as *const objc2_core_foundation::CFArray).cast::<AnyObject>() };
        let value = |dict: &AnyObject, key: &str| -> Option<Retained<AnyObject>> {
            let key = NSString::from_str(key);
            unsafe { msg_send![dict, objectForKey: &*key] }
        };
        let number = |dict: &AnyObject, key: &str| -> f64 { value(dict, key).map(|n| -> f64 { unsafe { msg_send![&*n, doubleValue] } }).unwrap_or(0.0) };
        let count: usize = unsafe { msg_send![array, count] };
        (0..count)
            .filter_map(|i| {
                let dict: Retained<AnyObject> = unsafe { msg_send![array, objectAtIndex: i] };
                let owner = value(&dict, "kCGWindowOwnerName").map(|name| unsafe { &*Retained::as_ptr(&name).cast::<NSString>() }.to_string()).unwrap_or_default();
                let bounds = value(&dict, "kCGWindowBounds")?;
                Some(super::ScreenWindow { owner, pid: number(&dict, "kCGWindowOwnerPID") as i64, layer: number(&dict, "kCGWindowLayer") as i64, width: number(&bounds, "Width"), height: number(&bounds, "Height") })
            })
            .collect()
    }

    pub fn seconds_since_person_input() -> f64 {
        // kCGAnyInputEventType: any mouse, trackpad or keyboard event from the hardware.
        CGEventSource::seconds_since_last_event_type(CGEventSourceStateID::HIDSystemState, CGEventType(u32::MAX))
    }

    pub fn send(pv: &tauri::webview::PlatformWebview, step: &InputStep, number: isize) -> Result<String, String> {
        let mtm = MainThreadMarker::new().ok_or("Input must be sent on the main thread")?;
        let (view, window) = (pv.inner() as *const NSView, pv.ns_window() as *const NSWindow);
        if view.is_null() || window.is_null() {
            return Err("The web view is not in a window".into());
        }
        // SAFETY: Tauri hands us its live WKWebView (an NSView) and NSWindow on the main thread.
        let t = unsafe { Target { view: &*view, window: &*window, mtm } };
        let now = NSProcessInfo::processInfo().systemUptime();
        match step {
            InputStep::Down { x, y } | InputStep::Drag { x, y } | InputStep::Up { x, y } => {
                let (ty, pressure, name) = match step {
                    InputStep::Down { .. } => (NSEventType::LeftMouseDown, 1.0, "down"),
                    InputStep::Drag { .. } => (NSEventType::LeftMouseDragged, 1.0, "drag"),
                    _ => (NSEventType::LeftMouseUp, 0.0, "up"),
                };
                let at = t.window_point(*x, *y);
                let e = NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(ty, at, NSEventModifierFlags::empty(), now, t.window.windowNumber(), None, number, 1, pressure)
                    .ok_or("AppKit made no mouse event")?;
                match name {
                    "down" => t.view.mouseDown(&e),
                    "drag" => t.view.mouseDragged(&e),
                    _ => t.view.mouseUp(&e),
                }
                Ok(format!("mouse {name} at {x:.0},{y:.0}"))
            }
            InputStep::Scroll { x, y, dy } => {
                let cg = CGEvent::new_scroll_wheel_event2(None, CGScrollEventUnit::Pixel, 1, -dy, 0, 0).ok_or("Core Graphics made no scroll event")?;
                CGEvent::set_location(Some(&cg), t.cg_location(*x, *y));
                CGEvent::set_integer_value_field(Some(&cg), CGEventField::ScrollWheelEventIsContinuous, 1);
                let e = NSEvent::eventWithCGEvent(&cg).ok_or("AppKit could not read the scroll event")?;
                // Through the window, which finds the view under the pointer, as for a real trackpad.
                t.window.sendEvent(&e);
                Ok(format!("scroll {dy} at {x:.0},{y:.0}"))
            }
            InputStep::Pinch { x, y, magnification, phase } => {
                let phase_value: i64 = match phase.as_str() {
                    "began" => 1,
                    "changed" => 2,
                    "ended" => 4,
                    other => return Err(format!("Unknown pinch phase {other}")),
                };
                let cg = CGEvent::new(None).ok_or("Core Graphics made no event")?;
                CGEvent::set_type(Some(&cg), CGEventType(GESTURE_EVENT));
                CGEvent::set_location(Some(&cg), t.cg_location(*x, *y));
                CGEvent::set_integer_value_field(Some(&cg), CGEventField(FIELD_GESTURE_HID_TYPE), HID_ZOOM);
                CGEvent::set_double_value_field(Some(&cg), CGEventField(FIELD_GESTURE_ZOOM_VALUE), *magnification);
                CGEvent::set_integer_value_field(Some(&cg), CGEventField(FIELD_GESTURE_PHASE), phase_value);
                let e = NSEvent::eventWithCGEvent(&cg).ok_or("AppKit could not read the pinch event")?;
                if e.r#type() != NSEventType::Magnify {
                    return Err(format!("This macOS made event type {} from the pinch, not a magnify event", e.r#type().0));
                }
                // Through the window, which finds the view under the fingers, as for a real trackpad.
                t.window.sendEvent(&e);
                Ok(format!("pinch {phase} {:.2} at {x:.0},{y:.0}", e.magnification()))
            }
            InputStep::Key { key, code, down } => {
                let chars = NSString::from_str(key);
                let ty = if *down { NSEventType::KeyDown } else { NSEventType::KeyUp };
                let e = NSEvent::keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode(ty, NSPoint::new(0.0, 0.0), NSEventModifierFlags::empty(), now, t.window.windowNumber(), None, &chars, &chars, false, *code)
                    .ok_or("AppKit made no key event")?;
                t.window.makeFirstResponder(Some(&**t.view));
                if *down {
                    t.view.keyDown(&e);
                } else {
                    t.view.keyUp(&e);
                }
                Ok(format!("key {key} {}", if *down { "down" } else { "up" }))
            }
            InputStep::Move { x, y, dx, dy } => {
                let cg = CGEvent::new_mouse_event(None, CGEventType::MouseMoved, t.cg_location(*x, *y), CGMouseButton::Left).ok_or("Core Graphics made no mouse event")?;
                CGEvent::set_integer_value_field(Some(&cg), CGEventField::MouseEventDeltaX, *dx);
                CGEvent::set_integer_value_field(Some(&cg), CGEventField::MouseEventDeltaY, *dy);
                let e = NSEvent::eventWithCGEvent(&cg).ok_or("AppKit could not read the mouse move")?;
                // WebKit takes mouse moves from the owner of its mouse tracking area, which is where AppKit
                // delivers a real mouse's moves (in the focused window); the web view's own mouseMoved:
                // ignores them.
                let mut owners = 0;
                for area in t.view.trackingAreas().iter() {
                    if area.options().contains(NSTrackingAreaOptions::MouseMoved) {
                        if let Some(owner) = area.owner() {
                            // SAFETY: tracking area owners implement mouseMoved: (NSTrackingMouseMoved).
                            let _: () = unsafe { msg_send![&*owner, mouseMoved: &*e] };
                            owners += 1;
                        }
                    }
                }
                if owners == 0 {
                    return Err("The web view has no mouse tracking area".into());
                }
                Ok(format!("mouse move {dx},{dy} at {x:.0},{y:.0}"))
            }
            InputStep::Wait { .. } | InputStep::Focus => Ok(String::new()),
        }
    }

    pub fn snapshot(pv: &tauri::webview::PlatformWebview, done: Box<dyn FnOnce(Result<Vec<u8>, String>)>) {
        let view = pv.inner() as *const WKWebView;
        if view.is_null() {
            return done(Err("No web view".into()));
        }
        let done = RefCell::new(Some(done));
        let handler = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
            let Some(done) = done.borrow_mut().take() else { return };
            if image.is_null() {
                // SAFETY: WebKit passes a valid NSError or null with a null image.
                let why = unsafe { error.as_ref() }.map(|e| e.localizedDescription().to_string()).unwrap_or_else(|| "no image".into());
                return done(Err(format!("WebKit could not take a snapshot: {why}")));
            }
            // SAFETY: a non-null image from WebKit's completion handler.
            let image = unsafe { &*image };
            let png = image.TIFFRepresentation().and_then(|tiff| NSBitmapImageRep::imageRepWithData(&tiff)).and_then(|rep| unsafe { rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new()) });
            done(png.map(|d| d.to_vec()).ok_or_else(|| "Could not encode the snapshot as PNG".into()));
        });
        // SAFETY: Tauri hands us its live WKWebView on the main thread; WebKit copies the block.
        unsafe { (*view).takeSnapshotWithConfiguration_completionHandler(None, &handler) };
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    pub fn seconds_since_person_input() -> f64 {
        f64::MAX
    }

    pub fn windows_on_screen() -> Vec<super::ScreenWindow> {
        Vec::new()
    }

    use super::InputStep;

    pub fn send(_pv: &tauri::webview::PlatformWebview, _step: &InputStep, _number: isize) -> Result<String, String> {
        Err("Native input for the self-test is only implemented on macOS".into())
    }

    pub fn snapshot(_pv: &tauri::webview::PlatformWebview, done: Box<dyn FnOnce(Result<Vec<u8>, String>)>) {
        done(Err("Web view snapshots for the self-test are only implemented on macOS".into()))
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn lists_windows_on_screen_without_titles() {
        // Empty without a window server (for example over SSH); otherwise every entry has an owner and a size.
        let windows = super::windows_on_screen();
        for w in &windows {
            assert!(w.width >= 0.0 && w.height >= 0.0, "{w:?}");
        }
        if std::env::var_os("SHOW_WINDOWS").is_some() {
            for w in windows.iter().filter(|w| w.layer == 0) {
                println!("{} (pid {}) {}x{}", w.owner, w.pid, w.width, w.height);
            }
        }
    }
}
