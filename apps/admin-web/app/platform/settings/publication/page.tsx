import { redirect } from "next/navigation";

// Legacy HTTP publication settings are no longer the active control plane.
export default function LegacyPublicationSettingsPage() {
  redirect("/platform/readback");
}
