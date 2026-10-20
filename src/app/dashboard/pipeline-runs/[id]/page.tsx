import { redirect } from "next/navigation";

/** A pipeline run's old address. Pipelines became the task board. */
export default function PipelineRunPage() {
  redirect("/dashboard/board");
}
