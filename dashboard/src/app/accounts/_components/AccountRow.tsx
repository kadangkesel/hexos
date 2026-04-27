"use client";

import { TableRow, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import { Loader2, ShieldCheck, Trash2 } from "lucide-react";
import {
  getStatus,
  isActive,
  STATUS_BADGE_VARIANT,
  STATUS_BADGE_CLASS,
  STATUS_LABEL,
  formatDate,
  creditDisplay,
} from "./account-helpers";
import type { AccountRowProps } from "./account-helpers";

export function AccountRow({ conn, onToggle, onCheck, onRemove, busy }: AccountRowProps) {
  const isBusy = busy === conn.id;
  const status = getStatus(conn);
  const active = isActive(conn);
  const usageCount = (conn as Record<string, unknown>).usageCount as number | undefined;
  const failCount = (conn as Record<string, unknown>).failCount as number | undefined;
  const lastUsedAt = (conn as Record<string, unknown>).lastUsedAt as string | undefined;

  return (
    <TableRow>
      <TableCell className="max-w-[200px] truncate font-medium">
        <div className="flex items-center gap-1.5">
          {conn.label ?? conn.email}
          <Badge variant="outline" className="text-[9px] font-mono shrink-0">
            {({ Service: "CB", cline: "CL", kiro: "KR", qoder: "QD", codex: "CX", yepapi: "YP" } as Record<string, string>)[String((conn as any).provider)] || String((conn as any).provider)}
          </Badge>
        </div>
      </TableCell>
      <TableCell>
        <Badge
          variant={STATUS_BADGE_VARIANT[status]}
          className={STATUS_BADGE_CLASS[status]}
        >
          {STATUS_LABEL[status]}
        </Badge>
      </TableCell>
      <TableCell className="text-right">{usageCount ?? 0}</TableCell>
      <TableCell className="text-right text-xs text-muted-foreground">
        {formatDate(lastUsedAt)}
      </TableCell>
      <TableCell className="text-right text-xs">{creditDisplay(conn)}</TableCell>
      <TableCell className="text-right">
        {(failCount ?? 0) > 0 ? (
          <span className="text-destructive font-medium">{failCount}</span>
        ) : (
          <span className="text-muted-foreground">0</span>
        )}
      </TableCell>
      <TableCell>
        <div className="flex items-center justify-end gap-2">
          {/* Enable / Disable toggle */}
          <Switch
            size="sm"
            checked={active}
            disabled={isBusy}
            onCheckedChange={() => onToggle(conn.id, active)}
          />

          {/* Check Token */}
          <Button
            variant="ghost"
            size="icon-xs"
            disabled={isBusy}
            onClick={() => onCheck(conn.id)}
            title="Check Token"
          >
            {isBusy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ShieldCheck className="h-3.5 w-3.5" />
            )}
          </Button>

          {/* Remove with confirm Dialog */}
          <Dialog>
            <DialogTrigger
              render={
                <Button
                  variant="destructive"
                  size="icon-xs"
                  disabled={isBusy}
                  title="Remove"
                />
              }
            >
              <Trash2 className="h-3.5 w-3.5" />
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Remove Account</DialogTitle>
                <DialogDescription>
                  Are you sure you want to remove <strong>{conn.label ?? conn.email}</strong>? This action cannot
                  be undone.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
                <Button variant="destructive" onClick={() => onRemove(conn.id)}>
                  Remove
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </TableCell>
    </TableRow>
  );
}
