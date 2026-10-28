"""Background keyboard and mouse input for Nyerk's Input Overlay.

A message-only window registers for Windows Raw Input with RIDEV_INPUTSINK, so it receives
keyboard and mouse button data while another application is in the foreground. Input is
shown locally through the addon's event channel; it is never saved or sent over the network.
"""
from __future__ import annotations

import ctypes
import os
import re
import threading
import time
from ctypes import wintypes
from typing import Any

WM_INPUT = 0x00FF
WM_KEYDOWN = 0x0100
WM_KEYUP = 0x0101
WM_SYSKEYDOWN = 0x0104
WM_SYSKEYUP = 0x0105
RID_INPUT = 0x10000003
RIDEV_INPUTSINK = 0x00000100
RIM_TYPEMOUSE = 0
RIM_TYPEKEYBOARD = 1
RI_KEY_BREAK = 0x0001
RI_KEY_E0 = 0x0002
RI_MOUSE_LEFT_BUTTON_DOWN = 0x0001
RI_MOUSE_LEFT_BUTTON_UP = 0x0002
RI_MOUSE_RIGHT_BUTTON_DOWN = 0x0004
RI_MOUSE_RIGHT_BUTTON_UP = 0x0008
RI_MOUSE_MIDDLE_BUTTON_DOWN = 0x0010
RI_MOUSE_MIDDLE_BUTTON_UP = 0x0020
RI_MOUSE_BUTTON_4_DOWN = 0x0040
RI_MOUSE_BUTTON_4_UP = 0x0080
RI_MOUSE_BUTTON_5_DOWN = 0x0100
RI_MOUSE_BUTTON_5_UP = 0x0200
RI_MOUSE_WHEEL = 0x0400
RI_MOUSE_HWHEEL = 0x0800


class RAWINPUTHEADER(ctypes.Structure):
    _fields_ = [
        ("dwType", wintypes.DWORD),
        ("dwSize", wintypes.DWORD),
        ("hDevice", ctypes.c_void_p),
        ("wParam", ctypes.c_size_t),
    ]


class RAWKEYBOARD(ctypes.Structure):
    _fields_ = [
        ("MakeCode", wintypes.USHORT),
        ("Flags", wintypes.USHORT),
        ("Reserved", wintypes.USHORT),
        ("VKey", wintypes.USHORT),
        ("Message", wintypes.UINT),
        ("ExtraInformation", wintypes.ULONG),
    ]


class RAWMOUSEBUTTONDATA(ctypes.Structure):
    _fields_ = [("usButtonFlags", wintypes.USHORT), ("usButtonData", wintypes.USHORT)]


class RAWMOUSEBUTTONS(ctypes.Union):
    _fields_ = [("ulButtons", wintypes.ULONG), ("data", RAWMOUSEBUTTONDATA)]


class RAWMOUSE(ctypes.Structure):
    _fields_ = [
        ("usFlags", wintypes.USHORT),
        ("buttons", RAWMOUSEBUTTONS),
        ("ulRawButtons", wintypes.ULONG),
        ("lLastX", wintypes.LONG),
        ("lLastY", wintypes.LONG),
        ("ulExtraInformation", wintypes.ULONG),
    ]


class RAWINPUTDATA(ctypes.Union):
    _fields_ = [("mouse", RAWMOUSE), ("keyboard", RAWKEYBOARD)]


class RAWINPUT(ctypes.Structure):
    _fields_ = [("header", RAWINPUTHEADER), ("data", RAWINPUTDATA)]


class RAWINPUTDEVICE(ctypes.Structure):
    _fields_ = [
        ("usUsagePage", wintypes.USHORT),
        ("usUsage", wintypes.USHORT),
        ("dwFlags", wintypes.DWORD),
        ("hwndTarget", ctypes.c_void_p),
    ]


class MSG(ctypes.Structure):
    _fields_ = [
        ("hwnd", ctypes.c_void_p),
        ("message", wintypes.UINT),
        ("wParam", ctypes.c_size_t),
        ("lParam", ctypes.c_ssize_t),
        ("time", wintypes.DWORD),
        ("pt", wintypes.POINT),
        ("lPrivate", wintypes.DWORD),
    ]


def setup(api: Any) -> None:
    if os.name != "nt":
        api.log("Input Overlay needs Windows; background input was not started.")
        api.emit("inputStatus", {"state": "error", "detail": "Windows is required"})
        return

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    lresult = ctypes.c_ssize_t
    wndproc_type = ctypes.WINFUNCTYPE(lresult, ctypes.c_void_p, wintypes.UINT, ctypes.c_size_t, ctypes.c_ssize_t)

    class WNDCLASSW(ctypes.Structure):
        _fields_ = [
            ("style", wintypes.UINT),
            ("lpfnWndProc", wndproc_type),
            ("cbClsExtra", ctypes.c_int),
            ("cbWndExtra", ctypes.c_int),
            ("hInstance", ctypes.c_void_p),
            ("hIcon", ctypes.c_void_p),
            ("hCursor", ctypes.c_void_p),
            ("hbrBackground", ctypes.c_void_p),
            ("lpszMenuName", wintypes.LPCWSTR),
            ("lpszClassName", wintypes.LPCWSTR),
        ]

    user32.RegisterClassW.argtypes = [ctypes.POINTER(WNDCLASSW)]
    user32.RegisterClassW.restype = wintypes.USHORT
    user32.CreateWindowExW.argtypes = [
        wintypes.DWORD, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD,
        ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
        ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p,
    ]
    user32.CreateWindowExW.restype = ctypes.c_void_p
    user32.RegisterRawInputDevices.argtypes = [ctypes.POINTER(RAWINPUTDEVICE), wintypes.UINT, wintypes.UINT]
    user32.RegisterRawInputDevices.restype = wintypes.BOOL
    user32.GetRawInputData.argtypes = [
        ctypes.c_void_p, wintypes.UINT, ctypes.c_void_p,
        ctypes.POINTER(wintypes.UINT), wintypes.UINT,
    ]
    user32.GetRawInputData.restype = wintypes.UINT
    user32.GetKeyNameTextW.argtypes = [ctypes.c_long, wintypes.LPWSTR, ctypes.c_int]
    user32.GetKeyNameTextW.restype = ctypes.c_int
    user32.DefWindowProcW.argtypes = [ctypes.c_void_p, wintypes.UINT, ctypes.c_size_t, ctypes.c_ssize_t]
    user32.DefWindowProcW.restype = lresult
    user32.GetMessageW.argtypes = [ctypes.POINTER(MSG), ctypes.c_void_p, wintypes.UINT, wintypes.UINT]
    user32.GetMessageW.restype = wintypes.BOOL
    user32.TranslateMessage.argtypes = [ctypes.POINTER(MSG)]
    user32.DispatchMessageW.argtypes = [ctypes.POINTER(MSG)]
    kernel32.GetModuleHandleW.argtypes = [wintypes.LPCWSTR]
    kernel32.GetModuleHandleW.restype = ctypes.c_void_p

    lock = threading.Lock()
    enabled = {"captureKeys": True, "captureMouse": True}
    # Do not expose inputs before the background page sends the saved filter.
    allowed_inputs: set[str] | None = set()
    aliases: dict[str, str] = {}
    listen_mode = False
    pressed_keys: dict[int, tuple[str, str] | None] = {}
    pressed_mouse: dict[str, tuple[str, str] | None] = {}
    def normalize(label: str) -> str:
        return " ".join(label.strip().split()).casefold()

    def parse_filter(source: Any) -> set[str] | None:
        tokens = [part.strip() for part in re.split(r"[,;\n]+", str(source or "")) if part.strip()]
        if any(token in ("*", "all") for token in (part.casefold() for part in tokens)):
            return None
        result: set[str] = set()
        for token in tokens:
            upper = token.upper().replace(" ", "")
            letter_range = re.fullmatch(r"([A-Z])-([A-Z])", upper)
            digit_range = re.fullmatch(r"([0-9])-([0-9])", upper)
            function_range = re.fullmatch(r"F(\d+)-F(\d+)", upper)
            if letter_range:
                first, last = (ord(letter_range.group(1)), ord(letter_range.group(2)))
                result.update(chr(code).casefold() for code in range(min(first, last), max(first, last) + 1))
            elif digit_range:
                first, last = (int(digit_range.group(1)), int(digit_range.group(2)))
                result.update(str(number) for number in range(min(first, last), max(first, last) + 1))
            elif function_range:
                first, last = (int(function_range.group(1)), int(function_range.group(2)))
                result.update(f"f{number}" for number in range(min(first, last), max(first, last) + 1))
            else:
                result.add(normalize(token))
        return result

    def parse_aliases(source: Any) -> dict[str, str]:
        result: dict[str, str] = {}
        if isinstance(source, dict):
            for original, alias in source.items():
                if str(original).strip() and str(alias).strip():
                    result[normalize(str(original))] = str(alias).strip()[:48]
            return result
        for entry in re.split(r"[,;\n]+", str(source or "")):
            original, separator, alias = entry.partition("=")
            if separator and original.strip() and alias.strip():
                result[normalize(original)] = alias.strip()[:48]
        return result

    @api.on_settings
    def on_settings(values: dict) -> None:
        with lock:
            enabled["captureKeys"] = values.get("captureKeys", True) is True
            enabled["captureMouse"] = values.get("captureMouse", True) is True

    @api.on_message
    def on_message(name: str, data: Any) -> None:
        nonlocal allowed_inputs, aliases, listen_mode
        payload = data if isinstance(data, dict) else {}
        with lock:
            if name == "configure":
                allowed_inputs = parse_filter(payload.get("inputFilter", "*"))
                aliases = parse_aliases(payload.get("aliases", ""))
            elif name == "listen":
                listen_mode = payload.get("on") is True

    def display_label(label: str) -> str | None:
        normalized = normalize(label)
        if not listen_mode and allowed_inputs is not None and normalized not in allowed_inputs:
            return None
        return aliases.get(normalized, label)

    def emit(kind: str, label: str, state: str = "tap", source: str | None = None) -> None:
        api.emit("input", {"kind": kind, "label": label, "source": source or label, "state": state, "at": int(time.monotonic() * 1000)})

    def key_name(item: RAWKEYBOARD) -> str:
        key_lparam = (int(item.MakeCode) << 16) | (0x01000000 if item.Flags & RI_KEY_E0 else 0)
        buffer = ctypes.create_unicode_buffer(64)
        result = user32.GetKeyNameTextW(key_lparam, buffer, len(buffer))
        return buffer.value if result else f"Key {int(item.VKey):02X}"

    def keyboard_event(item: RAWKEYBOARD) -> None:
        vk = int(item.VKey)
        if vk == 0xFF:
            return
        is_up = bool(item.Flags & RI_KEY_BREAK) or item.Message in (WM_KEYUP, WM_SYSKEYUP)
        event: tuple[str, str, str] | None = None
        with lock:
            if is_up:
                held = pressed_keys.pop(vk, None) if vk in pressed_keys else None
                if held is not None and enabled["captureKeys"]:
                    event = (held[0], held[1], "up")
            elif vk not in pressed_keys:
                source = key_name(item)
                label = display_label(source)
                held = (label, source) if label is not None and enabled["captureKeys"] else None
                pressed_keys[vk] = held
                if held is not None:
                    event = (held[0], held[1], "down")
        if event:
            emit("key", event[0], event[2], source=event[1])

    def mouse_event(item: RAWMOUSE) -> None:
        flags = int(item.buttons.data.usButtonFlags)
        if flags & (RI_MOUSE_WHEEL | RI_MOUSE_HWHEEL):
            raw_delta = int(item.buttons.data.usButtonData)
            delta = raw_delta if raw_delta < 0x8000 else raw_delta - 0x10000
            if delta:
                if flags & RI_MOUSE_WHEEL:
                    label = "Scroll up" if delta > 0 else "Scroll down"
                else:
                    label = "Scroll right" if delta > 0 else "Scroll left"
                with lock:
                    shown_label = display_label(label) if enabled["captureMouse"] else None
                if shown_label is not None:
                    emit("mouse", shown_label, source=label)
        transitions = (
            (RI_MOUSE_LEFT_BUTTON_DOWN, RI_MOUSE_LEFT_BUTTON_UP, "left", "Left click"),
            (RI_MOUSE_RIGHT_BUTTON_DOWN, RI_MOUSE_RIGHT_BUTTON_UP, "right", "Right click"),
            (RI_MOUSE_MIDDLE_BUTTON_DOWN, RI_MOUSE_MIDDLE_BUTTON_UP, "middle", "Middle click"),
            (RI_MOUSE_BUTTON_4_DOWN, RI_MOUSE_BUTTON_4_UP, "x1", "Mouse 4"),
            (RI_MOUSE_BUTTON_5_DOWN, RI_MOUSE_BUTTON_5_UP, "x2", "Mouse 5"),
        )
        for down, up, button, label in transitions:
            if not (flags & (down | up)):
                continue
            event: tuple[str, str, str] | None = None
            with lock:
                if flags & up:
                    held = pressed_mouse.pop(button, None) if button in pressed_mouse else None
                    if held is not None and enabled["captureMouse"]:
                        event = (held[0], held[1], "up")
                if flags & down and button not in pressed_mouse:
                    shown_label = display_label(label)
                    held = (shown_label, label) if shown_label is not None and enabled["captureMouse"] else None
                    pressed_mouse[button] = held
                    if held is not None:
                        event = (held[0], held[1], "down")
            if event:
                emit("mouse", event[0], event[2], source=event[1])

    def read_input(handle: int) -> None:
        size = wintypes.UINT(0)
        header_size = ctypes.sizeof(RAWINPUTHEADER)
        hraw = ctypes.c_void_p(handle & ((1 << (ctypes.sizeof(ctypes.c_void_p) * 8)) - 1))
        result = user32.GetRawInputData(hraw, RID_INPUT, None, ctypes.byref(size), header_size)
        if result == 0xFFFFFFFF or size.value < ctypes.sizeof(RAWINPUTHEADER):
            return
        buffer = ctypes.create_string_buffer(size.value)
        copied = user32.GetRawInputData(hraw, RID_INPUT, buffer, ctypes.byref(size), header_size)
        if copied == 0xFFFFFFFF:
            return
        raw = ctypes.cast(buffer, ctypes.POINTER(RAWINPUT)).contents
        if raw.header.dwType == RIM_TYPEKEYBOARD:
            keyboard_event(raw.data.keyboard)
        elif raw.header.dwType == RIM_TYPEMOUSE:
            mouse_event(raw.data.mouse)

    @wndproc_type
    def window_proc(hwnd: ctypes.c_void_p, message: int, wparam: int, lparam: int) -> int:
        if message == WM_INPUT:
            try:
                read_input(int(lparam))
            except Exception as error:  # keep the hidden window's message pump alive
                api.log(f"Raw input read failed: {type(error).__name__}: {error}")
            return user32.DefWindowProcW(hwnd, message, wparam, lparam)
        return user32.DefWindowProcW(hwnd, message, wparam, lparam)

    def input_loop() -> None:
        class_name = f"NyerkInputOverlay_{os.getpid()}"
        instance = kernel32.GetModuleHandleW(None)
        window_class = WNDCLASSW()
        window_class.lpfnWndProc = window_proc
        window_class.hInstance = instance
        window_class.lpszClassName = class_name
        if not user32.RegisterClassW(ctypes.byref(window_class)):
            error = ctypes.get_last_error()
            api.log(f"Could not register background input window (Windows error {error}).")
            api.emit("inputStatus", {"state": "error", "detail": f"Windows error {error}"})
            return

        hwnd_message = ctypes.c_void_p(-3)  # HWND_MESSAGE: message-only, never shown on screen
        hwnd = user32.CreateWindowExW(
            0, class_name, "", 0, 0, 0, 0, 0, hwnd_message, None, instance, None
        )
        if not hwnd:
            error = ctypes.get_last_error()
            api.log(f"Could not create background input window (Windows error {error}).")
            api.emit("inputStatus", {"state": "error", "detail": f"Windows error {error}"})
            return

        devices = (RAWINPUTDEVICE * 2)(
            RAWINPUTDEVICE(0x01, 0x06, RIDEV_INPUTSINK, hwnd),  # generic desktop, keyboard
            RAWINPUTDEVICE(0x01, 0x02, RIDEV_INPUTSINK, hwnd),  # generic desktop, mouse
        )
        if not user32.RegisterRawInputDevices(devices, 2, ctypes.sizeof(RAWINPUTDEVICE)):
            error = ctypes.get_last_error()
            api.log(f"Could not register background keyboard and mouse input (Windows error {error}).")
            api.emit("inputStatus", {"state": "error", "detail": f"Windows error {error}"})
            return

        api.log("Background keyboard and mouse input are active.")
        api.emit("inputStatus", {"state": "active", "method": "Raw Input background sink", "reset": True})
        message = MSG()
        while user32.GetMessageW(ctypes.byref(message), None, 0, 0) > 0:
            user32.TranslateMessage(ctypes.byref(message))
            user32.DispatchMessageW(ctypes.byref(message))

    threading.Thread(target=input_loop, name="nyerk-input-overlay-rawinput", daemon=True).start()
