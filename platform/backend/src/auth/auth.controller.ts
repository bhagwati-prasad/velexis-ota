// The portal identity routes (platform/docs/api-inventory.md §4, `AuthModule`): sign-up, e-mail verification and the
// resend of the verification link (PBE-013). Sign-in, refresh and sign-out (PBE-014), the MFA steps (PBE-015) and the
// password reset (PBE-016) join this controller. Thin: each handler binds its operation, reads the validated body and
// makes one service call. All three operations are `public`; their rate limits are the operations' throttlers.
import { Controller, HttpCode, Post } from "@nestjs/common";
import { OpenApiOperation, Validated } from "../common/http/openapi-operation.decorator";
import {
  SignUpService,
  type EmailVerified,
  type ResendVerificationRequest,
  type SignUpAccepted,
  type SignUpRequest,
  type VerifyEmailRequest,
} from "./sign-up.service";

@Controller("v1/auth")
export class AuthController {
  constructor(private readonly signUps: SignUpService) {}

  @Post("sign-up")
  @HttpCode(202)
  @OpenApiOperation("signUp")
  signUp(@Validated("body") body: SignUpRequest): Promise<SignUpAccepted> {
    return this.signUps.signUp(body);
  }

  @Post("verify-email")
  @HttpCode(200)
  @OpenApiOperation("verifyEmail")
  verifyEmail(@Validated("body") body: VerifyEmailRequest): Promise<EmailVerified> {
    return this.signUps.verifyEmail(body.token);
  }

  /** `202` without a body, whatever the address. */
  @Post("resend-verification")
  @HttpCode(202)
  @OpenApiOperation("resendVerification")
  resendVerification(@Validated("body") body: ResendVerificationRequest): Promise<void> {
    return this.signUps.resendVerification(body);
  }
}
