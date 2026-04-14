export function LoginScreen({ onLogin, error }) {
  return (
    <div className="min-h-screen bg-bg flex items-center justify-center">
      <div className="bg-surface border border-border rounded-[12px] p-10 w-full max-w-sm text-center shadow-lg">
        <div className="text-[11px] font-mono uppercase tracking-[2px] text-muted mb-2">Homebase Support</div>
        <div className="text-xl font-bold text-text mb-1">Rep Activity Dashboard</div>
        <div className="text-xs text-muted mb-8">Sign in with your Databricks account to continue</div>

        {error && (
          <div className="mb-4 px-3 py-2 rounded-md bg-danger/10 border border-danger/30 text-danger text-xs font-mono">
            {error}
          </div>
        )}

        <button
          onClick={onLogin}
          className="w-full bg-accent hover:bg-accent/90 text-white text-sm font-medium px-4 py-2.5 rounded-md transition-colors cursor-pointer"
        >
          Sign in with Databricks
        </button>
      </div>
    </div>
  );
}
