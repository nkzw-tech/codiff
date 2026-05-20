type NativeInputEventTarget = EventTarget & {
  closest?: (selector: string) => Element | null;
  isContentEditable?: boolean;
};

export const isNativeInputTarget = (target: EventTarget | null) => {
  const candidate = target as NativeInputEventTarget | null;
  return (
    candidate?.closest?.('input, select, textarea') != null || candidate?.isContentEditable === true
  );
};

export const isMacPlatform = (platform = navigator.platform) =>
  platform.toLowerCase().includes('mac');

export const isDiffSearchShortcut = (
  event: Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey'>,
  platform = navigator.platform,
) => {
  if (event.altKey || event.shiftKey || event.key.toLowerCase() !== 'f') {
    return false;
  }

  return isMacPlatform(platform)
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
};

export const getReloadShortcutLabel = () => {
  return isMacPlatform() ? '⌘R' : 'Ctrl+R';
};
