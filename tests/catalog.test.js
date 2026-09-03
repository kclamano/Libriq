import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { issueToken } from '../api/auth.js';
import { createTestServer, apiRequest } from './helpers/testServer.js';

describe('Catalog & Inventory Operations', () => {
  let testEnv;
  let adminToken;
  let userAToken;
  let userBToken;

  before(async () => {
    testEnv = await createTestServer();
    adminToken = issueToken({ userId: 'admin-1', role: 'admin' });
    userAToken = issueToken({ userId: 'user-a', role: 'user' });
    userBToken = issueToken({ userId: 'user-b', role: 'user' });
  });

  after(async () => {
    await testEnv.close();
  });

  beforeEach(() => {
    testEnv.catalog.clear();
  });

  describe('Resource CRUD Operations', () => {
    it('creates a new resource with valid inventory counts', async () => {
      const res = await apiRequest(testEnv.url, '/api/catalog/resources', {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}` },
        body: {
          title: 'The Pragmatic Programmer',
          author: 'Andy Hunt & Dave Thomas',
          isbn: '9780201616224',
          totalCopies: 3,
        },
      });

      assert.equal(res.status, 201);
      assert.equal(res.data.success, true);
      const book = res.data.data;
      assert.equal(book.title, 'The Pragmatic Programmer');
      assert.equal(book.status, 'available');
      assert.equal(book.totalCopies, 3);
      assert.equal(book.availableCopies, 3);
      assert.equal(book.reservedCopies, 0);
      assert.equal(book.checkedOutCopies, 0);
      assert.equal(book.deletedAt, null);
    });

    it('retrieves an existing resource by ID', async () => {
      const created = testEnv.catalog.createResource({
        title: 'Clean Architecture',
        author: 'Robert C. Martin',
      });

      const res = await apiRequest(testEnv.url, `/api/catalog/resources/${created.id}`);
      assert.equal(res.status, 200);
      assert.equal(res.data.success, true);
      assert.equal(res.data.data.title, 'Clean Architecture');
    });

    it('lists resources with optional filtering', async () => {
      testEnv.catalog.createResource({ title: 'Refactoring', author: 'Martin Fowler' });
      testEnv.catalog.createResource({ title: 'Domain-Driven Design', author: 'Eric Evans' });

      const resAll = await apiRequest(testEnv.url, '/api/catalog/resources');
      assert.equal(resAll.status, 200);
      assert.equal(resAll.data.data.length, 2);

      const resFilter = await apiRequest(testEnv.url, '/api/catalog/resources?search=Fowler');
      assert.equal(resFilter.status, 200);
      assert.equal(resFilter.data.data.length, 1);
      assert.equal(resFilter.data.data[0].title, 'Refactoring');
    });

    it('updates resource metadata', async () => {
      const created = testEnv.catalog.createResource({
        title: 'Original Title',
        author: 'Original Author',
      });

      const res = await apiRequest(testEnv.url, `/api/catalog/resources/${created.id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${adminToken}` },
        body: { title: 'Updated Title' },
      });

      assert.equal(res.status, 200);
      assert.equal(res.data.data.title, 'Updated Title');
      assert.equal(res.data.data.author, 'Original Author');
    });

    it('supports soft deletion', async () => {
      const created = testEnv.catalog.createResource({
        title: 'Book to Soft Delete',
        author: 'Author',
      });

      const deleteRes = await apiRequest(testEnv.url, `/api/catalog/resources/${created.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${adminToken}` },
      });

      assert.equal(deleteRes.status, 200);
      assert.equal(deleteRes.data.success, true);
      assert.ok(deleteRes.data.data.deletedAt);

      // Normal get returns 404
      const getRes = await apiRequest(testEnv.url, `/api/catalog/resources/${created.id}`);
      assert.equal(getRes.status, 404);

      // Including deleted returns the item with deletedAt timestamp
      const getDeletedRes = await apiRequest(testEnv.url, `/api/catalog/resources/${created.id}?includeDeleted=true`);
      assert.equal(getDeletedRes.status, 200);
      assert.ok(getDeletedRes.data.data.deletedAt);
    });

    it('supports hard deletion', async () => {
      const created = testEnv.catalog.createResource({
        title: 'Book to Hard Delete',
        author: 'Author',
      });

      const deleteRes = await apiRequest(testEnv.url, `/api/catalog/resources/${created.id}?hard=true`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${adminToken}` },
      });

      assert.equal(deleteRes.status, 200);
      assert.equal(deleteRes.data.data.hard, true);

      // Completely removed, even with includeDeleted=true
      const getRes = await apiRequest(testEnv.url, `/api/catalog/resources/${created.id}?includeDeleted=true`);
      assert.equal(getRes.status, 404);
    });
  });

  describe('State Transition Invariants & Concurrency Conflict Prevention', () => {
    it('prevents simultaneous reservation of a single-copy resource by another user', async () => {
      const book = testEnv.catalog.createResource({
        title: 'Rare Manuscript',
        author: 'Ancient Author',
        totalCopies: 1,
      });

      // User A reserves the resource -> succeeds
      const resA = await apiRequest(testEnv.url, `/api/catalog/resources/${book.id}/reserve`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${userAToken}` },
      });

      assert.equal(resA.status, 200);
      assert.equal(resA.data.data.status, 'reserved');
      assert.equal(resA.data.data.availableCopies, 0);
      assert.equal(resA.data.data.reservedCopies, 1);

      // User B attempts to simultaneously reserve the same resource -> rejected with 409 Conflict
      const resB = await apiRequest(testEnv.url, `/api/catalog/resources/${book.id}/reserve`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${userBToken}` },
      });

      assert.equal(resB.status, 409);
      assert.equal(resB.data.success, false);
      assert.equal(resB.data.error.code, 'RESOURCE_ALREADY_RESERVED');
      assert.match(resB.data.error.message, /cannot be reserved/i);
    });

    it('prevents a user from reserving a resource they already have reserved or checked out', async () => {
      const book = testEnv.catalog.createResource({
        title: 'Multi-Copy Guide',
        author: 'Author',
        totalCopies: 2,
      });

      // User A reserves once
      const firstRes = await apiRequest(testEnv.url, `/api/catalog/resources/${book.id}/reserve`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${userAToken}` },
      });
      assert.equal(firstRes.status, 200);

      // User A attempts to reserve again -> duplicate reservation rejected with 409
      const secondRes = await apiRequest(testEnv.url, `/api/catalog/resources/${book.id}/reserve`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${userAToken}` },
      });
      assert.equal(secondRes.status, 409);
      assert.equal(secondRes.data.error.code, 'DUPLICATE_RESERVATION');
    });

    it('prevents checking out a resource that is reserved by another user', async () => {
      const book = testEnv.catalog.createResource({
        title: 'Single Copy Novel',
        author: 'Author',
        totalCopies: 1,
      });

      // User A reserves it
      await apiRequest(testEnv.url, `/api/catalog/resources/${book.id}/reserve`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${userAToken}` },
      });

      // User B attempts to check it out directly -> rejected with 409
      const checkoutB = await apiRequest(testEnv.url, `/api/catalog/resources/${book.id}/checkout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${userBToken}` },
      });

      assert.equal(checkoutB.status, 409);
      assert.equal(checkoutB.data.error.code, 'RESOURCE_UNAVAILABLE');
    });

    it('allows the reserving user to fulfill their reservation via checkout', async () => {
      const book = testEnv.catalog.createResource({
        title: 'Reserved Book',
        author: 'Author',
        totalCopies: 1,
      });

      // User A reserves
      await apiRequest(testEnv.url, `/api/catalog/resources/${book.id}/reserve`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${userAToken}` },
      });

      // User A checks out their reserved book -> transitions from reserved to checked_out
      const checkoutA = await apiRequest(testEnv.url, `/api/catalog/resources/${book.id}/checkout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${userAToken}` },
      });

      assert.equal(checkoutA.status, 200);
      assert.equal(checkoutA.data.data.status, 'checked_out');
      assert.equal(checkoutA.data.data.availableCopies, 0);
      assert.equal(checkoutA.data.data.reservedCopies, 0);
      assert.equal(checkoutA.data.data.checkedOutCopies, 1);
    });
  });

  describe('Resource Return Workflows & Inventory Count Reconciliation', () => {
    it('executes return workflow and transitions status back to available', async () => {
      const book = testEnv.catalog.createResource({
        title: 'Borrowed Book',
        author: 'Author',
        totalCopies: 1,
      });

      // Check out
      await apiRequest(testEnv.url, `/api/catalog/resources/${book.id}/checkout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${userAToken}` },
      });

      // Return resource
      const returnRes = await apiRequest(testEnv.url, `/api/catalog/resources/${book.id}/return`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${userAToken}` },
      });

      assert.equal(returnRes.status, 200);
      assert.equal(returnRes.data.data.status, 'available');
      assert.equal(returnRes.data.data.availableCopies, 1);
      assert.equal(returnRes.data.data.checkedOutCopies, 0);
      assert.equal(returnRes.data.data.reservedCopies, 0);
    });

    it('maintains strict inventory count reconciliation invariants across multi-user operations', async () => {
      const book = testEnv.catalog.createResource({
        title: 'Shared Resource Textbook',
        author: 'Professor X',
        totalCopies: 5,
      });

      // User A checks out
      await apiRequest(testEnv.url, `/api/catalog/resources/${book.id}/checkout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${userAToken}` },
      });

      // User B reserves
      await apiRequest(testEnv.url, `/api/catalog/resources/${book.id}/reserve`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${userBToken}` },
      });

      // Reconcile inventory
      const reconcileRes = await apiRequest(testEnv.url, `/api/catalog/resources/${book.id}/reconcile`);

      assert.equal(reconcileRes.status, 200);
      const data = reconcileRes.data.data;
      assert.equal(data.valid, true);
      assert.equal(data.totalCopies, 5);
      assert.equal(data.availableCopies, 3);
      assert.equal(data.reservedCopies, 1);
      assert.equal(data.checkedOutCopies, 1);
      assert.equal(data.totalCopies, data.availableCopies + data.reservedCopies + data.checkedOutCopies);

      // Now User A returns their copy
      await apiRequest(testEnv.url, `/api/catalog/resources/${book.id}/return`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${userAToken}` },
      });

      // Verify count reconciliation after return
      const afterReturn = await apiRequest(testEnv.url, `/api/catalog/resources/${book.id}/reconcile`);
      assert.equal(afterReturn.data.data.availableCopies, 4);
      assert.equal(afterReturn.data.data.checkedOutCopies, 0);
      assert.equal(afterReturn.data.data.reservedCopies, 1);
      assert.equal(
        afterReturn.data.data.totalCopies,
        afterReturn.data.data.availableCopies + afterReturn.data.data.reservedCopies + afterReturn.data.data.checkedOutCopies
      );
    });

    it('rejects return from a user with no active checkout or reservation', async () => {
      const book = testEnv.catalog.createResource({
        title: 'Unborrowed Book',
        author: 'Author',
        totalCopies: 1,
      });

      const res = await apiRequest(testEnv.url, `/api/catalog/resources/${book.id}/return`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${userBToken}` },
      });

      assert.equal(res.status, 400);
      assert.equal(res.data.error.code, 'NO_ACTIVE_TRANSACTION');
    });
  });
});
