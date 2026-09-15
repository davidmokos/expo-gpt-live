import { useEffect, useId, useRef, type ReactNode } from 'react';

export function WebSheet({
  isPresented,
  onDismiss,
  title,
  children,
}: {
  isPresented: boolean;
  onDismiss: () => void;
  title: string;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    if (isPresented) dialog.current?.showModal();
    else dialog.current?.close();
  }, [isPresented]);
  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onDismiss();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onDismiss();
      }}
      style={{
        colorScheme: 'dark',
        color: '#F5F5F5',
        background: '#1C1C1C',
        border: 0,
        borderRadius: 28,
        padding: 0,
        width: 'min(480px, calc(100% - 32px))',
        maxHeight: '80vh',
      }}
    >
      <div style={{ padding: 28, fontFamily: 'system-ui, sans-serif' }}>
        <header
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 28,
          }}
        >
          <h2 id={titleId} style={{ fontSize: 20, margin: 0 }}>
            {title}
          </h2>
          <button
            onClick={onDismiss}
            aria-label={`Close ${title.toLowerCase()}`}
            style={{
              border: 0,
              background: 'transparent',
              color: 'inherit',
              fontSize: 24,
              cursor: 'pointer',
              padding: 8,
            }}
          >
            ×
          </button>
        </header>
        {children}
      </div>
    </dialog>
  );
}
