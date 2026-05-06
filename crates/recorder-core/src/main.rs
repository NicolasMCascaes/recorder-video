use std::env;
use std::io::{self, Write};
use std::thread;
use std::time::{Duration, Instant};

#[derive(Clone, Copy, PartialEq, Eq)]
struct CursorPoint {
    x: i32,
    y: i32,
}

#[derive(Clone, Copy)]
struct ButtonSnapshot {
    left: bool,
    right: bool,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = env::args().collect();

    if args.get(1).map(String::as_str) == Some("capture-mouse") {
        let session = read_arg_value(&args, "--session")?;
        capture_mouse(session)?;
        return Ok(());
    }

    if args.get(1).map(String::as_str) == Some("window-bounds") {
        let source_id = read_arg_value(&args, "--source-id")?;
        print_window_bounds(&source_id)?;
        return Ok(());
    }

    if args.get(1).map(String::as_str) == Some("window-info") {
        let source_id = read_arg_value(&args, "--source-id")?;
        print_window_info(&source_id)?;
        return Ok(());
    }

    if args.get(1).map(String::as_str) == Some("virtual-screen-bounds") {
        print_virtual_screen_bounds()?;
        return Ok(());
    }

    println!(
        "{{\"status\":\"ok\",\"engine\":\"recorder-core\",\"os\":\"{}\",\"arch\":\"{}\"}}",
        std::env::consts::OS,
        std::env::consts::ARCH
    );

    Ok(())
}

fn read_arg_value(args: &[String], name: &str) -> Result<String, String> {
    let index = args
        .iter()
        .position(|arg| arg == name)
        .ok_or_else(|| format!("Missing argument: {name}"))?;

    args.get(index + 1)
        .cloned()
        .ok_or_else(|| format!("Missing value for argument: {name}"))
}

#[cfg(target_os = "windows")]
fn capture_mouse(session: String) -> Result<(), Box<dyn std::error::Error>> {
    use std::mem::size_of;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetCursorInfo, CURSORINFO, CURSOR_SHOWING,
    };

    const LEFT_BUTTON: i32 = 0x01;
    const RIGHT_BUTTON: i32 = 0x02;

    let started_at = Instant::now();
    let mut previous_point: Option<CursorPoint> = None;
    let mut previous_buttons = ButtonSnapshot {
        left: false,
        right: false,
    };
    let mut stdout = io::BufWriter::new(io::stdout());

    loop {
        let mut cursor_info = CURSORINFO {
            cbSize: size_of::<CURSORINFO>() as u32,
            flags: 0,
            hCursor: std::ptr::null_mut(),
            ptScreenPos: windows_sys::Win32::Foundation::POINT { x: 0, y: 0 },
        };

        let has_cursor = unsafe { GetCursorInfo(&mut cursor_info) } != 0;
        let is_visible = cursor_info.flags == CURSOR_SHOWING;
        let now = started_at.elapsed().as_millis();

        if has_cursor && is_visible {
            let point = CursorPoint {
                x: cursor_info.ptScreenPos.x,
                y: cursor_info.ptScreenPos.y,
            };

            if previous_point != Some(point) {
                write_event(&mut stdout, &session, now, point, "move", None)?;
                previous_point = Some(point);
            }
        }

        let buttons = ButtonSnapshot {
            left: unsafe { GetAsyncKeyState(LEFT_BUTTON) } < 0,
            right: unsafe { GetAsyncKeyState(RIGHT_BUTTON) } < 0,
        };

        if let Some(point) = previous_point {
            if buttons.left != previous_buttons.left {
                write_event(
                    &mut stdout,
                    &session,
                    now,
                    point,
                    if buttons.left { "down" } else { "up" },
                    Some("left"),
                )?;
            }

            if buttons.right != previous_buttons.right {
                write_event(
                    &mut stdout,
                    &session,
                    now,
                    point,
                    if buttons.right { "down" } else { "up" },
                    Some("right"),
                )?;
            }
        }

        previous_buttons = buttons;
        stdout.flush()?;
        thread::sleep(Duration::from_millis(16));
    }
}

#[cfg(not(target_os = "windows"))]
fn capture_mouse(_session: String) -> Result<(), Box<dyn std::error::Error>> {
    Err("capture-mouse is only available on Windows".into())
}

#[cfg(target_os = "windows")]
fn print_window_bounds(source_id: &str) -> Result<(), Box<dyn std::error::Error>> {
    use windows_sys::Win32::Foundation::RECT;
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetWindowRect, IsWindow};

    let hwnd_value = parse_window_handle(source_id)?;
    let hwnd = hwnd_value as windows_sys::Win32::Foundation::HWND;

    if unsafe { IsWindow(hwnd) } == 0 {
        return Err(format!("Window handle is not available for source: {source_id}").into());
    }

    let mut rect = RECT {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
    };

    if unsafe { GetWindowRect(hwnd, &mut rect) } == 0 {
        return Err(format!("Could not read window bounds for source: {source_id}").into());
    }

    let width = rect.right - rect.left;
    let height = rect.bottom - rect.top;

    println!(
        "{{\"x\":{},\"y\":{},\"width\":{},\"height\":{}}}",
        rect.left, rect.top, width, height
    );

    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn print_window_bounds(_source_id: &str) -> Result<(), Box<dyn std::error::Error>> {
    Err("window-bounds is only available on Windows".into())
}

#[cfg(target_os = "windows")]
fn print_window_info(source_id: &str) -> Result<(), Box<dyn std::error::Error>> {
    use windows_sys::Win32::Foundation::RECT;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetWindowRect, IsIconic, IsWindow, IsWindowVisible,
    };

    let hwnd_value = parse_window_handle(source_id)?;
    let hwnd = hwnd_value as windows_sys::Win32::Foundation::HWND;

    if unsafe { IsWindow(hwnd) } == 0 {
        return Err(format!("Window handle is not available for source: {source_id}").into());
    }

    let mut rect = RECT {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
    };

    if unsafe { GetWindowRect(hwnd, &mut rect) } == 0 {
        return Err(format!("Could not read window info for source: {source_id}").into());
    }

    let width = rect.right - rect.left;
    let height = rect.bottom - rect.top;
    let is_visible = unsafe { IsWindowVisible(hwnd) } != 0;
    let is_minimized = unsafe { IsIconic(hwnd) } != 0;

    println!(
        "{{\"x\":{},\"y\":{},\"width\":{},\"height\":{},\"windowHandle\":\"{}\",\"isVisible\":{},\"isMinimized\":{}}}",
        rect.left,
        rect.top,
        width,
        height,
        hwnd_value,
        is_visible,
        is_minimized
    );

    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn print_window_info(_source_id: &str) -> Result<(), Box<dyn std::error::Error>> {
    Err("window-info is only available on Windows".into())
}

#[cfg(target_os = "windows")]
fn print_virtual_screen_bounds() -> Result<(), Box<dyn std::error::Error>> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
    };

    let x = unsafe { GetSystemMetrics(SM_XVIRTUALSCREEN) };
    let y = unsafe { GetSystemMetrics(SM_YVIRTUALSCREEN) };
    let width = unsafe { GetSystemMetrics(SM_CXVIRTUALSCREEN) };
    let height = unsafe { GetSystemMetrics(SM_CYVIRTUALSCREEN) };

    println!(
        "{{\"x\":{},\"y\":{},\"width\":{},\"height\":{}}}",
        x, y, width, height
    );

    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn print_virtual_screen_bounds() -> Result<(), Box<dyn std::error::Error>> {
    Err("virtual-screen-bounds is only available on Windows".into())
}

fn parse_window_handle(source_id: &str) -> Result<isize, Box<dyn std::error::Error>> {
    let mut parts = source_id.split(':');
    let kind = parts.next().ok_or("Missing source kind.")?;
    let raw_handle = parts.next().ok_or("Missing native window handle.")?;

    if kind != "window" {
        return Err(format!("Unsupported source kind for window bounds: {kind}").into());
    }

    raw_handle
        .parse::<isize>()
        .map_err(|error| format!("Invalid native window handle '{raw_handle}': {error}").into())
}

fn write_event(
    stdout: &mut io::BufWriter<io::Stdout>,
    session: &str,
    t: u128,
    point: CursorPoint,
    event_type: &str,
    button: Option<&str>,
) -> io::Result<()> {
    if let Some(button) = button {
        writeln!(
            stdout,
            "{{\"session\":\"{}\",\"t\":{},\"x\":{},\"y\":{},\"type\":\"{}\",\"button\":\"{}\"}}",
            escape_json(session),
            t,
            point.x,
            point.y,
            event_type,
            button
        )
    } else {
        writeln!(
            stdout,
            "{{\"session\":\"{}\",\"t\":{},\"x\":{},\"y\":{},\"type\":\"{}\"}}",
            escape_json(session),
            t,
            point.x,
            point.y,
            event_type
        )
    }
}

fn escape_json(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}
