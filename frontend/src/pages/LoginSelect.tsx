import { useEffect } from "react";
import { useLocation } from "wouter";

export default function LoginSelect() {
  const [, navigate] = useLocation();
  useEffect(() => { navigate("/", { replace: true }); }, [navigate]);
  return null;
}
