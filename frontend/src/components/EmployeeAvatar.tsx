import { User } from "lucide-react";

/**
 * Shows the employee's uploaded photo when available, otherwise falls back
 * to a default user icon. Used everywhere an employee avatar is displayed
 * so the photo feature applies portal-wide from one place.
 */
export default function EmployeeAvatar({
  photoUrl,
  name,
  size = 36,
  className = "",
}: {
  photoUrl?: string | null;
  name?: string;
  size?: number;
  className?: string;
}) {
  if (photoUrl) {
    return (
      <img
        src={photoUrl}
        alt={name ?? "Employee"}
        className={`rounded-full object-cover shrink-0 ${className}`}
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <div
      className={`rounded-full bg-gray-100 flex items-center justify-center shrink-0 ${className}`}
      style={{ width: size, height: size }}
    >
      <User size={size * 0.55} className="text-gray-400" />
    </div>
  );
}
