import { redirect } from "next/navigation";

export default async function LegacyCanvasPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  redirect(`/app/p/${projectId}/graph-editor`);
}
