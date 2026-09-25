import {
  OrgPermission,
  OrgRole,
  roleHasPermission,
} from './organization-permissions';

describe('organization roles', () => {
  it('gives the owner every permission', () => {
    for (const permission of Object.values(OrgPermission)) {
      expect(roleHasPermission(OrgRole.Owner, permission)).toBe(true);
    }
  });

  it.each([
    [OrgRole.Admin, OrgPermission.ManageMembers, true],
    [OrgRole.Admin, OrgPermission.ManageApiKeys, true],
    [OrgRole.Admin, OrgPermission.ManageOrganization, false],
    [OrgRole.Member, OrgPermission.CreatePayments, true],
    [OrgRole.Member, OrgPermission.ManageMembers, false],
    [OrgRole.Member, OrgPermission.ManageApiKeys, false],
    [OrgRole.Viewer, OrgPermission.ReadTransactions, true],
    [OrgRole.Viewer, OrgPermission.CreatePayments, false],
  ])('%s has %s: %s', (role, permission, expected) => {
    expect(roleHasPermission(role, permission)).toBe(expected);
  });
});
