"use client";

export function ChatPlaceholder() {
  return (
    <div className="rounded-lg border border-dashed border-border bg-card flex flex-col h-full min-h-[420px]">
      <div className="px-4 py-3 border-b border-border">
        <h3 className="text-sm font-semibold">AI Chat</h3>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center p-6">
        <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center mb-4">
          <svg
            className="w-6 h-6 text-muted-foreground"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
            />
          </svg>
        </div>
        <p className="text-sm text-muted-foreground text-center">
          AI assistant coming soon
        </p>
        <p className="text-xs text-muted-foreground mt-1 text-center">
          Manage your vault with natural language
        </p>
      </div>

      <div className="p-3 border-t border-border">
        <div className="flex gap-2">
          <input
            type="text"
            disabled
            placeholder="Ask anything..."
            className="flex-1 py-2 px-3 rounded-md bg-accent border border-border text-sm opacity-50 cursor-not-allowed"
          />
          <button
            disabled
            className="py-2 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium opacity-50 cursor-not-allowed"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
