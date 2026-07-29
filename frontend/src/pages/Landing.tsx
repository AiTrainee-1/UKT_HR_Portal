import { useLocation } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import { useEffect } from "react";

export default function Landing() {
  const [, navigate] = useLocation();
  const { isAuthenticated, user } = useAuth();

  useEffect(() => {
    if (isAuthenticated && user) {
      navigate(user.role === "hr" ? "/hr/dashboard" : "/employee/dashboard", { replace: true });
    } else {
      navigate("/hr-login", { replace: true });
    }
  }, [isAuthenticated, user, navigate]);

  return null;
}
