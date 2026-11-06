import { EVENT_HUB_EVENTS, type Category } from '../constants';
import { adminActor } from './actor';
import { entryLabel } from './labels';
import type { Actor } from './types';

/** What an event hub payload contributes to an entry. Actor and request come from elsewhere. */
export interface MappedEvent {
  action: string;
  category: Category;
  targetUid?: string;
  targetId?: string;
  targetLabel?: string;
  details?: Record<string, unknown>;
  /** Set when the payload itself names the actor (login and logout run before `state.user`). */
  actorOverride?: Actor;
  /**
   * Used only when nobody is signed in. Creating the first admin and accepting an invite both
   * happen before a session exists, and the person doing it is the account in the payload.
   */
  fallbackActor?: Actor;
}

type Payload = Record<string, unknown> | undefined;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const idOf = (record: Record<string, unknown> | undefined): string | undefined => {
  const id = record?.documentId ?? record?.id;
  return id === undefined || id === null ? undefined : String(id);
};

const roleIds = (roles: unknown): unknown[] =>
  Array.isArray(roles)
    ? roles.map((role) => (role && typeof role === 'object' ? (role as Record<string, unknown>).id : role))
    : [];

/**
 * Maps a Strapi event hub event to the fields of a log entry.
 *
 * Every payload is picked apart field by field rather than stored whole. The `user.*` payload,
 * for example, is a full admin user, and copying it in would put password hashes and reset
 * tokens into the log if a future Strapi version stopped sanitising it.
 */
export function mapEvent(name: string, payload: Payload): MappedEvent | null {
  const category = EVENT_HUB_EVENTS[name];
  if (!category) return null;

  const base: MappedEvent = { action: name, category };

  switch (category) {
    case 'auth': {
      const user = asRecord(payload?.user);
      return {
        ...base,
        action: name === 'admin.auth.success' ? 'admin.login' : 'admin.logout',
        targetUid: 'admin::user',
        targetId: idOf(user),
        targetLabel: typeof user?.email === 'string' ? user.email : undefined,
        details: payload?.provider ? { provider: payload.provider } : undefined,
        actorOverride: user ? adminActor(user) : undefined,
      };
    }

    case 'admin-user': {
      const user = asRecord(payload?.user);
      return {
        ...base,
        action: name.replace(/^user\./, 'admin-user.'),
        targetUid: 'admin::user',
        targetId: idOf(user),
        targetLabel: typeof user?.email === 'string' ? user.email : undefined,
        fallbackActor: user ? adminActor(user) : undefined,
        details: user
          ? {
              email: user.email,
              firstname: user.firstname,
              lastname: user.lastname,
              isActive: user.isActive,
              blocked: user.blocked,
              roles: roleIds(user.roles),
            }
          : undefined,
      };
    }

    case 'role': {
      if (name.startsWith('permission.')) {
        const permissions = Array.isArray(payload?.permissions) ? (payload?.permissions as unknown[]) : [];
        const actions = [
          ...new Set(
            permissions
              .map((permission) => asRecord(permission)?.action)
              .filter((action): action is string => typeof action === 'string')
          ),
        ];
        return {
          ...base,
          targetUid: 'admin::permission',
          details: { count: permissions.length, actions: actions.slice(0, 50) },
        };
      }

      const role = asRecord(payload?.role);
      return {
        ...base,
        targetUid: 'admin::role',
        targetId: idOf(role),
        targetLabel: entryLabel(role),
        details: role ? { code: role.code, description: role.description } : undefined,
      };
    }

    case 'schema': {
      const isComponent = name.startsWith('component.');
      const definition = asRecord(isComponent ? payload?.component : payload?.contentType);
      const info = asRecord(definition?.info) ?? asRecord(asRecord(definition?.schema)?.info);
      const uid = typeof definition?.uid === 'string' ? definition.uid : undefined;

      return {
        ...base,
        targetUid: isComponent ? 'component' : uid,
        targetId: uid,
        targetLabel: typeof info?.displayName === 'string' ? info.displayName : uid,
        details: { kind: isComponent ? 'component' : asRecord(definition)?.kind },
      };
    }

    default:
      return base;
  }
}
