import { redirect } from "next/navigation";

/** Pipelines became the task board: a chain of steps is cards that wait for each other. */
export default function PipelinesPage() {
  redirect("/dashboard/board");
}
