"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
          aria-label="Changer de thème"
        >
          <Sun className="hidden dark:block" />
          <Moon className="dark:hidden" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>Thème clair / sombre</TooltipContent>
    </Tooltip>
  );
}
