// Toasts: mount <ToastProvider> once near the root, then call `useToast().add(message,
// { title, variant: 'neutral' | 'success' | 'warning' | 'danger', duration })` from any child.
export { ToastProvider, useToast, type ToastProviderProps } from '@muxui/react';
export { Toast, type ToastManager, type ToastOptions, type ToastProps } from '@muxui/react';
