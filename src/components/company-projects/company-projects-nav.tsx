"use client";

import { useRouter, usePathname } from "next/navigation";
import { Building2 } from "lucide-react";
import { useI18n } from "@/i18n/provider";
import { SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { useCompanyProjects } from "./use-company-projects";

export function companyProjectPath(id: string): string {
  return `/dashboard/company/${encodeURIComponent(id)}`;
}

/**
 * The company's projects, after the person's own in the project list: the
 * same row, a building instead of a folder, and whose it is on hover. They
 * open a page of their own rather than switching the workspace's project,
 * since the project lives in the administrator's workspace, not here.
 */
export function CompanyProjectsNav() {
  const { t } = useI18n();
  const router = useRouter();
  const pathname = usePathname();
  const list = useCompanyProjects();
  if (!list?.enabled || list.projects.length === 0) return null;
  return (
    <>
      {list.projects.map((project) => {
        const href = companyProjectPath(project.id);
        return (
          <SidebarMenuItem key={project.id}>
            <SidebarMenuButton
              isActive={pathname === href || pathname.startsWith(`${href}/`)}
              onClick={() => router.push(href)}
              title={t("companyProjects.from", { name: project.from })}
            >
              <Building2 className="size-4" />
              <span className="truncate">{project.title}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        );
      })}
    </>
  );
}
