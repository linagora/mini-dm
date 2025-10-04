import nock from 'nock';

import { DM } from '../../../src/bin';
import James from '../../../src/plugins/twake/james';
import { expect } from 'chai';
import OnLdapChange from '../../../src/plugins/ldap/onChange';

describe('James Plugin', () => {
  const testDN = `uid=testusermail,${process.env.DM_LDAP_BASE}`;
  let dm: DM;
  let james: James;
  let scope: nock.Scope;

  before(function () {
    // Skip tests if env vars are not set
    if (
      !process.env.DM_LDAP_DN ||
      !process.env.DM_LDAP_PWD ||
      !process.env.DM_LDAP_BASE
    ) {
      // eslint-disable-next-line no-console
      console.warn(
        'Skipping LDAP tests: DM_LDAP_DN or DM_LDAP_PWD or DM_LDAP_BASE not set'
      );
      (this as Mocha.Context).skip();
    }
    scope = nock(process.env.DM_JAMES_WEBADMIN_URL || 'http://localhost:8000')
      //.post(new RegExp('users/testmail@test.org/rename/t@t.org.*'))
      .persist()
      .post('/users/testmail@test.org/rename/t@t.org?action=rename')
      .reply(200, { success: true })
      .get('/jmap/identities/testmail@test.org')
      .reply(200, [
        {
          id: 'testmail-identity-id',
          name: 'Test User',
          email: 'testmail@test.org',
        },
      ])
      .put('/jmap/identities/testmail@test.org/testmail-identity-id')
      .reply(200, { success: true });
    nock.disableNetConnect();
  });

  after(function () {
    nock.cleanAll();
    nock.enableNetConnect();
  });

  beforeEach(async () => {
    dm = new DM();
    await dm.ready;
    james = new James(dm);
    dm.registerPlugin('onLdapChange', new OnLdapChange(dm));
    dm.registerPlugin('james', james);
  });

  afterEach(async () => {
    // Clean up: delete the test entry if it exists
    try {
      await dm.ldap.delete(testDN);
    } catch (err) {
      // Ignore errors if the entry does not exist
    }
  });

  it("should try to rename mailbox via James's webadmin", async () => {
    const entry = {
      objectClass: ['top', 'inetOrgPerson'],
      cn: 'Test User',
      sn: 'User',
      uid: 'testusermail',
      mail: 'testmail@test.org',
    };
    let res = await dm.ldap.add(testDN, entry);
    expect(res).to.be.true;
    res = await dm.ldap.modify(testDN, {
      replace: { mail: 't@t.org' },
    });
    expect(res).to.be.true;
  });

  describe('Identity synchronization', () => {
    const testDN2 = `uid=testidentity,${process.env.DM_LDAP_BASE}`;
    const testDN3 = `uid=newuser,${process.env.DM_LDAP_BASE}`;
    let identityScope: nock.Scope;

    before(function () {
      // Mock JMAP identity endpoints
      identityScope = nock(
        process.env.DM_JAMES_WEBADMIN_URL || 'http://localhost:8000'
      )
        .persist()
        .get('/jmap/identities/identity@test.org')
        .reply(200, [
          {
            id: 'identity-id-1',
            name: 'Old Name',
            email: 'identity@test.org',
          },
        ])
        .put('/jmap/identities/identity@test.org/identity-id-1')
        .reply(200, { success: true })
        .get('/jmap/identities/newuser@test.org')
        .reply(200, [
          {
            id: 'newuser-identity-id',
            name: '',
            email: 'newuser@test.org',
          },
        ])
        .put('/jmap/identities/newuser@test.org/newuser-identity-id')
        .reply(200, { success: true });
    });

    afterEach(async () => {
      // Clean up: delete the test entries if they exist
      try {
        await dm.ldap.delete(testDN2);
      } catch (err) {
        // Ignore errors if the entry does not exist
      }
      try {
        await dm.ldap.delete(testDN3);
      } catch (err) {
        // Ignore errors if the entry does not exist
      }
    });

    it('should update James identity when displayName changes', async () => {
      const entry = {
        objectClass: ['top', 'inetOrgPerson'],
        cn: 'Identity Test',
        sn: 'Test',
        uid: 'testidentity',
        mail: 'identity@test.org',
        displayName: 'Old Name',
      };
      let res = await dm.ldap.add(testDN2, entry);
      expect(res).to.be.true;

      // Modify displayName
      res = await dm.ldap.modify(testDN2, {
        replace: { displayName: 'New Display Name' },
      });
      expect(res).to.be.true;
    });

    it('should update James identity when cn changes', async () => {
      const entry = {
        objectClass: ['top', 'inetOrgPerson'],
        cn: 'Old CN',
        sn: 'Test',
        uid: 'testidentity',
        mail: 'identity@test.org',
      };
      let res = await dm.ldap.add(testDN2, entry);
      expect(res).to.be.true;

      // Modify cn
      res = await dm.ldap.modify(testDN2, {
        replace: { cn: 'New CN' },
      });
      expect(res).to.be.true;
    });

    it('should use cn as fallback when displayName is not present', async () => {
      const entry = {
        objectClass: ['top', 'inetOrgPerson'],
        cn: 'John Doe',
        sn: 'Doe',
        uid: 'testidentity',
        mail: 'identity@test.org',
      };
      let res = await dm.ldap.add(testDN2, entry);
      expect(res).to.be.true;

      // Test getDisplayNameFromDN method directly before modify
      let displayName = await james.getDisplayNameFromDN(testDN2);
      expect(displayName).to.equal('John Doe');

      // Modify cn - this should trigger identity update using cn
      res = await dm.ldap.modify(testDN2, {
        replace: { cn: 'Jane Doe' },
      });
      expect(res).to.be.true;

      // Test getDisplayNameFromDN method again after modify
      displayName = await james.getDisplayNameFromDN(testDN2);
      expect(displayName).to.equal('Jane Doe');
    });

    it('should initialize James identity when user is created', async () => {
      const entry = {
        objectClass: ['top', 'inetOrgPerson'],
        cn: 'New User',
        sn: 'User',
        uid: 'newuser',
        mail: 'newuser@test.org',
        displayName: 'New User Display',
      };
      let res = await dm.ldap.add(testDN3, entry);
      expect(res).to.be.true;

      // Wait for the ldapadddone hook to execute (with 1s delay in hook)
      await new Promise(resolve => setTimeout(resolve, 1200));
    });
  });

  describe('Signature template', () => {
    const testDN4 = `uid=testsignature,${process.env.DM_LDAP_BASE}`;
    let signatureScope: nock.Scope;
    let savedTemplate: string | undefined;

    before(function () {
      // Save current template and set test template
      savedTemplate = process.env.DM_JAMES_SIGNATURE_TEMPLATE;
      process.env.DM_JAMES_SIGNATURE_TEMPLATE =
        '--<br/>{givenName} {sn}<br/>{title}<br/>{departmentNumber}';

      // Mock JMAP identity endpoints for signature test
      signatureScope = nock(
        process.env.DM_JAMES_WEBADMIN_URL || 'http://localhost:8000'
      )
        .persist()
        .get('/jmap/identities/signature@test.org')
        .reply(200, [
          {
            id: 'signature-identity-id',
            name: 'John Doe',
            email: 'signature@test.org',
          },
        ])
        .put('/jmap/identities/signature@test.org/signature-identity-id')
        .reply(200, { success: true });
    });

    after(function () {
      // Restore original template
      if (savedTemplate !== undefined) {
        process.env.DM_JAMES_SIGNATURE_TEMPLATE = savedTemplate;
      } else {
        delete process.env.DM_JAMES_SIGNATURE_TEMPLATE;
      }
    });

    afterEach(async () => {
      try {
        await dm.ldap.delete(testDN4);
      } catch (err) {
        // Ignore errors if the entry does not exist
      }
    });

    it('should generate signature from template and LDAP attributes', async () => {
      const entry = {
        objectClass: ['top', 'inetOrgPerson'],
        cn: 'John Doe',
        sn: 'Doe',
        givenName: 'John',
        uid: 'testsignature',
        mail: 'signature@test.org',
        title: 'Software Engineer',
        departmentNumber: 'IT Department',
        displayName: 'John Doe',
      };
      let res = await dm.ldap.add(testDN4, entry);
      expect(res).to.be.true;

      // Test signature generation directly
      const signature = await james.generateSignature(testDN4);
      expect(signature).to.equal(
        '--<br/>John Doe<br/>Software Engineer<br/>IT Department'
      );
    });

    it('should update James identity with signature on user modification', async () => {
      const entry = {
        objectClass: ['top', 'inetOrgPerson'],
        cn: 'John Doe',
        sn: 'Doe',
        givenName: 'John',
        uid: 'testsignature',
        mail: 'signature@test.org',
        title: 'Software Engineer',
        departmentNumber: 'IT',
        displayName: 'John Doe',
      };
      let res = await dm.ldap.add(testDN4, entry);
      expect(res).to.be.true;

      // Modify displayName to trigger identity update
      res = await dm.ldap.modify(testDN4, {
        replace: { displayName: 'John M. Doe' },
      });
      expect(res).to.be.true;

      // Wait for hook to execute
      await new Promise(resolve => setTimeout(resolve, 200));
    });

    it('should handle missing attributes in template gracefully', async () => {
      const entry = {
        objectClass: ['top', 'inetOrgPerson'],
        cn: 'Jane Smith',
        sn: 'Smith',
        givenName: 'Jane',
        uid: 'testsignature',
        mail: 'signature@test.org',
        displayName: 'Jane Smith',
        // Note: title and departmentNumber are missing
      };
      let res = await dm.ldap.add(testDN4, entry);
      expect(res).to.be.true;

      // Test signature generation with missing attributes
      const signature = await james.generateSignature(testDN4);
      expect(signature).to.equal('--<br/>Jane Smith<br/><br/>');
    });
  });
});
