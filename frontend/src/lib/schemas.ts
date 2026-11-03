import { z } from "zod";

export const PASSWORD_MIN_LENGTH = 10;

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `La contraseña debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres.`);

export const emailSchema = z.string().trim().min(1, "Introduce tu email.").email("Introduce un email válido.");

export const totpCodeSchema = z.string().regex(/^\d{6}$/, "El código tiene 6 dígitos.");

/** Nueva contraseña con confirmación (restablecer, invitación, cambio de contraseña). */
export const newPasswordSchema = z
  .object({ password: passwordSchema, confirm: z.string() })
  .refine((value) => value.password === value.confirm, {
    path: ["confirm"],
    message: "Las contraseñas no coinciden.",
  });

export type NewPasswordValues = z.infer<typeof newPasswordSchema>;
