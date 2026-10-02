"use client";

import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function LogoutButton() {
  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    // Rechargement complet (pas router.push) : garantit que le middleware
    // réévalue l'état d'authentification avec le cookie tout juste effacé.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.href = "/login";
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" onClick={handleLogout} aria-label="Se déconnecter">
          <LogOut />
        </Button>
      </TooltipTrigger>
      <TooltipContent>Se déconnecter</TooltipContent>
    </Tooltip>
  );
}
