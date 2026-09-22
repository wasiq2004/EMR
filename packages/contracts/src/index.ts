/**
 * @emr/contracts — the shared vocabulary between the API and the web clients.
 *
 * Every schema here is used verbatim on both sides: the API validates requests
 * against it, and the frontend builds its forms from it. A field rename breaks
 * the build rather than production.
 */

export * from './common';
export * from './enums';
export * from './rbac';
export * from './patient';
export * from './scheduling';
export * from './clinical';
export * from './drug-classes';
export * from './comms';
export * from './billing';
export * from './ops';
