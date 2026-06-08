import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

export const renderReact = async (element: ReactNode) => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(element);
  });

  return {
    cleanup: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
    container,
    rerender: async (nextElement: ReactNode) => {
      await act(async () => {
        root.render(nextElement);
      });
    },
  };
};

export const setInputValue = async (
  input: HTMLInputElement | HTMLTextAreaElement,
  value: string,
) => {
  await act(async () => {
    const valueSetter = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(input) as HTMLInputElement | HTMLTextAreaElement,
      'value',
    )?.set;
    valueSetter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

export const waitFor = async (assertion: () => void) => {
  let lastError: unknown;

  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }

  throw lastError;
};
