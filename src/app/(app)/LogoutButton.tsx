"use client";

export function LogoutButton() {
  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    // Rechargement complet (pas router.push) : garantit que le middleware
    // réévalue l'état d'authentification avec le cookie tout juste effacé.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.href = "/login";
  }

  return (
    <button
      onClick={handleLogout}
      className="text-sm text-zinc-600 hover:text-zinc-900"
    >
      Se déconnecter
    </button>
  );
}
