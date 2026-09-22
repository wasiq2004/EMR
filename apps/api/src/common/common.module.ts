import { Global, Module } from '@nestjs/common';

import { ClinicStatusCache } from './tenancy/clinic-status.cache';
import { PractitionerCredentialCache } from './rbac/practitioner-credential.cache';
import { AuditWriter } from './audit/audit.writer';
import { StorageService } from './storage/storage.service';
import { ShareLinkService } from './storage/share-link.service';
import { PasswordService } from './auth/password.service';
import { TokenService } from './auth/token.service';
import { TokenRevocationCache } from './auth/token-revocation.cache';
import { OtpService } from './auth/otp.service';

/**
 * Cross-cutting infrastructure.
 *
 * None of these is a feature and none has an owning module. Every feature module
 * writes audit entries; several read the clinic-status and credential caches;
 * documents and portability both need storage. Declaring them in the root
 * module does not work — a module cannot see its parent's providers — so they
 * would otherwise have to be re-imported by each of the fifteen feature
 * modules, which is fifteen places for one to be forgotten.
 *
 * Global is the right call precisely because the alternative is repetition
 * whose only failure mode is a missing audit trail.
 *
 * The auth primitives are here rather than in AuthModule for a harder reason:
 * TokenRevocationCache and OtpService hold state in memory. Two modules each
 * providing them means two instances, and a token revoked against one is still
 * accepted by the other. Single instance is a correctness requirement, not a
 * convenience.
 */
@Global()
@Module({
  providers: [
    ClinicStatusCache,
    PractitionerCredentialCache,
    AuditWriter,
    StorageService,
    ShareLinkService,
    PasswordService,
    TokenService,
    TokenRevocationCache,
    OtpService,
  ],
  exports: [
    ClinicStatusCache,
    PractitionerCredentialCache,
    AuditWriter,
    StorageService,
    ShareLinkService,
    PasswordService,
    TokenService,
    TokenRevocationCache,
    OtpService,
  ],
})
export class CommonModule {}
