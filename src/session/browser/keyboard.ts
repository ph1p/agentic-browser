export interface KeyDispatchPayload {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  nativeVirtualKeyCode: number;
  text?: string;
  unmodifiedText?: string;
}

export const SPECIAL_KEY_PAYLOADS = new Map<string, KeyDispatchPayload>([
  [
    "Enter",
    {
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      text: "\r",
      unmodifiedText: "\r",
    },
  ],
  ["Tab", { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 }],
  [
    "Escape",
    { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 },
  ],
  [
    "Backspace",
    { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 },
  ],
  [
    "Delete",
    { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46 },
  ],
  [
    "Space",
    {
      key: " ",
      code: "Space",
      windowsVirtualKeyCode: 32,
      nativeVirtualKeyCode: 32,
      text: " ",
      unmodifiedText: " ",
    },
  ],
  [
    " ",
    {
      key: " ",
      code: "Space",
      windowsVirtualKeyCode: 32,
      nativeVirtualKeyCode: 32,
      text: " ",
      unmodifiedText: " ",
    },
  ],
  [
    "ArrowUp",
    { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38, nativeVirtualKeyCode: 38 },
  ],
  [
    "ArrowDown",
    { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 },
  ],
  [
    "ArrowLeft",
    { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37, nativeVirtualKeyCode: 37 },
  ],
  [
    "ArrowRight",
    { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39 },
  ],
  ["Home", { key: "Home", code: "Home", windowsVirtualKeyCode: 36, nativeVirtualKeyCode: 36 }],
  ["End", { key: "End", code: "End", windowsVirtualKeyCode: 35, nativeVirtualKeyCode: 35 }],
  [
    "PageUp",
    { key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33, nativeVirtualKeyCode: 33 },
  ],
  [
    "PageDown",
    { key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34, nativeVirtualKeyCode: 34 },
  ],
]);

export function buildKeyDispatchPayload(inputKey: string): KeyDispatchPayload {
  const key = inputKey || "Enter";
  const special = SPECIAL_KEY_PAYLOADS.get(key);
  if (special) {
    return { ...special };
  }

  if (key.length === 1) {
    const upper = key.toUpperCase();
    const code =
      key >= "a" && key <= "z"
        ? `Key${upper}`
        : key >= "A" && key <= "Z"
          ? `Key${key}`
          : key >= "0" && key <= "9"
            ? `Digit${key}`
            : "Unidentified";
    const keyCode = upper.charCodeAt(0);
    return {
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
      text: key,
      unmodifiedText: key,
    };
  }

  return {
    key,
    code: key,
    windowsVirtualKeyCode: 0,
    nativeVirtualKeyCode: 0,
  };
}
