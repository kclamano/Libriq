import crypto from 'node:crypto';

export class CatalogError extends Error {
  constructor(message, code = 'CATALOG_ERROR', statusCode = 400, details = null) {
    super(message);
    this.name = 'CatalogError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

/**
 * In-memory Catalog and Inventory Store.
 * Enforces CRUD operations, soft/hard deletion, state transitions,
 * concurrency conflict prevention, and inventory reconciliation invariants.
 */
export class CatalogStore {
  constructor() {
    this.resources = new Map();
  }

  clear() {
    this.resources.clear();
  }

  _reconcileCounts(resource) {
    const total = resource.totalCopies;
    const reserved = resource.reservations.length;
    const checkedOut = resource.checkouts.length;
    const available = total - (reserved + checkedOut);

    if (available < 0) {
      throw new CatalogError(
        'Inventory count invariant violation: available copies cannot be negative.',
        'INVENTORY_INVARIANT_VIOLATION',
        500,
        { total, reserved, checkedOut, available }
      );
    }

    resource.reservedCopies = reserved;
    resource.checkedOutCopies = checkedOut;
    resource.availableCopies = available;

    if (available === total) {
      resource.status = 'available';
    } else if (available === 0) {
      resource.status = checkedOut > 0 ? 'checked_out' : 'reserved';
    } else {
      resource.status = 'partially_available';
    }

    return resource;
  }

  createResource(data) {
    if (!data.title || typeof data.title !== 'string') {
      throw new CatalogError('Title is required and must be a string.', 'INVALID_TITLE', 400);
    }
    if (!data.author || typeof data.author !== 'string') {
      throw new CatalogError('Author is required and must be a string.', 'INVALID_AUTHOR', 400);
    }

    const id = data.id || crypto.randomUUID();
    if (this.resources.has(id)) {
      throw new CatalogError(`Resource with ID ${id} already exists.`, 'RESOURCE_EXISTS', 409);
    }

    const now = new Date().toISOString();
    const totalCopies = typeof data.totalCopies === 'number' && data.totalCopies > 0 ? Math.floor(data.totalCopies) : 1;

    const resource = {
      id,
      title: data.title.trim(),
      author: data.author.trim(),
      isbn: data.isbn ? String(data.isbn).trim() : null,
      genres: Array.isArray(data.genres) ? data.genres : [],
      status: 'available',
      totalCopies,
      availableCopies: totalCopies,
      reservedCopies: 0,
      checkedOutCopies: 0,
      reservations: [],
      checkouts: [],
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };

    this.resources.set(id, resource);
    return { ...resource };
  }

  getResource(id, { includeDeleted = false } = {}) {
    const resource = this.resources.get(id);
    if (!resource) return null;
    if (resource.deletedAt && !includeDeleted) return null;
    return { ...resource };
  }

  listResources({ includeDeleted = false, status = null, search = '' } = {}) {
    const results = [];
    const searchLower = String(search || '').toLowerCase();

    for (const resource of this.resources.values()) {
      if (resource.deletedAt && !includeDeleted) continue;
      if (status && resource.status !== status) continue;
      if (searchLower) {
        const matchesTitle = resource.title.toLowerCase().includes(searchLower);
        const matchesAuthor = resource.author.toLowerCase().includes(searchLower);
        const matchesIsbn = resource.isbn?.toLowerCase().includes(searchLower);
        if (!matchesTitle && !matchesAuthor && !matchesIsbn) continue;
      }
      results.push({ ...resource });
    }

    return results;
  }

  updateResource(id, updates = {}) {
    const resource = this.resources.get(id);
    if (!resource || resource.deletedAt) {
      throw new CatalogError(`Resource ${id} not found.`, 'NOT_FOUND', 404);
    }

    // Do not allow updating internal invariants directly through update
    const disallowed = ['id', 'reservations', 'checkouts', 'availableCopies', 'reservedCopies', 'checkedOutCopies', 'createdAt'];
    for (const key of disallowed) {
      if (key in updates) {
        throw new CatalogError(`Field "${key}" cannot be updated directly.`, 'INVALID_UPDATE_FIELD', 400);
      }
    }

    if (updates.totalCopies !== undefined) {
      const newTotal = Math.floor(Number(updates.totalCopies));
      const occupied = resource.reservations.length + resource.checkouts.length;
      if (newTotal < occupied) {
        throw new CatalogError(
          `Cannot reduce totalCopies to ${newTotal}: ${occupied} copies currently reserved or checked out.`,
          'INVALID_INVENTORY_ADJUSTMENT',
          409
        );
      }
      resource.totalCopies = newTotal;
    }

    if (updates.title) resource.title = String(updates.title).trim();
    if (updates.author) resource.author = String(updates.author).trim();
    if (updates.isbn !== undefined) resource.isbn = updates.isbn ? String(updates.isbn).trim() : null;
    if (Array.isArray(updates.genres)) resource.genres = updates.genres;

    resource.updatedAt = new Date().toISOString();
    this._reconcileCounts(resource);
    return { ...resource };
  }

  softDeleteResource(id) {
    const resource = this.resources.get(id);
    if (!resource || resource.deletedAt) {
      throw new CatalogError(`Resource ${id} not found or already deleted.`, 'NOT_FOUND', 404);
    }

    if (resource.reservations.length > 0 || resource.checkouts.length > 0) {
      throw new CatalogError(
        `Cannot delete resource ${id}: active reservations or checkouts exist.`,
        'RESOURCE_IN_USE',
        409
      );
    }

    const now = new Date().toISOString();
    resource.deletedAt = now;
    resource.updatedAt = now;
    return { ...resource };
  }

  hardDeleteResource(id) {
    const resource = this.resources.get(id);
    if (!resource) {
      throw new CatalogError(`Resource ${id} not found.`, 'NOT_FOUND', 404);
    }

    if (resource.reservations.length > 0 || resource.checkouts.length > 0) {
      throw new CatalogError(
        `Cannot hard-delete resource ${id}: active reservations or checkouts exist.`,
        'RESOURCE_IN_USE',
        409
      );
    }

    this.resources.delete(id);
    return true;
  }

  reserveResource(id, userId) {
    if (!userId || typeof userId !== 'string') {
      throw new CatalogError('User ID is required for reservation.', 'INVALID_USER', 400);
    }

    const resource = this.resources.get(id);
    if (!resource || resource.deletedAt) {
      throw new CatalogError(`Resource ${id} not found.`, 'NOT_FOUND', 404);
    }

    // Invariant: User cannot double-reserve the same resource
    if (resource.reservations.some(r => r.userId === userId)) {
      throw new CatalogError('User already has an active reservation for this resource.', 'DUPLICATE_RESERVATION', 409);
    }

    // Invariant: User cannot reserve a resource they already checked out
    if (resource.checkouts.some(c => c.userId === userId)) {
      throw new CatalogError('User already has this resource checked out.', 'ALREADY_CHECKED_OUT', 409);
    }

    // Invariant: If no available copies remain, resource cannot be reserved by another user
    if (resource.availableCopies <= 0) {
      throw new CatalogError(
        'Resource cannot be reserved: no copies currently available (checked out or reserved by another user).',
        'RESOURCE_ALREADY_RESERVED',
        409
      );
    }

    const now = new Date().toISOString();
    resource.reservations.push({
      userId,
      reservedAt: now,
      expiresAt: new Date(Date.now() + 86400000).toISOString(), // 24h
    });

    resource.updatedAt = now;
    this._reconcileCounts(resource);
    return { ...resource };
  }

  checkoutResource(id, userId) {
    if (!userId || typeof userId !== 'string') {
      throw new CatalogError('User ID is required for checkout.', 'INVALID_USER', 400);
    }

    const resource = this.resources.get(id);
    if (!resource || resource.deletedAt) {
      throw new CatalogError(`Resource ${id} not found.`, 'NOT_FOUND', 404);
    }

    if (resource.checkouts.some(c => c.userId === userId)) {
      throw new CatalogError('User already has this resource checked out.', 'ALREADY_CHECKED_OUT', 409);
    }

    // Check if reserved by this user
    const userReservationIdx = resource.reservations.findIndex(r => r.userId === userId);

    if (userReservationIdx !== -1) {
      // User is fulfilling their existing reservation
      resource.reservations.splice(userReservationIdx, 1);
    } else {
      // Direct checkout requires an available copy
      if (resource.availableCopies <= 0) {
        throw new CatalogError(
          'Resource is unavailable for checkout: all copies are reserved or checked out.',
          'RESOURCE_UNAVAILABLE',
          409
        );
      }
    }

    const now = new Date().toISOString();
    resource.checkouts.push({
      userId,
      checkedOutAt: now,
      dueAt: new Date(Date.now() + 14 * 86400000).toISOString(), // 14 days
    });

    resource.updatedAt = now;
    this._reconcileCounts(resource);
    return { ...resource };
  }

  returnResource(id, userId) {
    if (!userId || typeof userId !== 'string') {
      throw new CatalogError('User ID is required to return a resource.', 'INVALID_USER', 400);
    }

    const resource = this.resources.get(id);
    if (!resource) {
      throw new CatalogError(`Resource ${id} not found.`, 'NOT_FOUND', 404);
    }

    const checkoutIdx = resource.checkouts.findIndex(c => c.userId === userId);
    const reservationIdx = resource.reservations.findIndex(r => r.userId === userId);

    if (checkoutIdx === -1 && reservationIdx === -1) {
      throw new CatalogError(`No active checkout or reservation found for user ${userId} on resource ${id}.`, 'NO_ACTIVE_TRANSACTION', 400);
    }

    if (checkoutIdx !== -1) {
      resource.checkouts.splice(checkoutIdx, 1);
    } else if (reservationIdx !== -1) {
      resource.reservations.splice(reservationIdx, 1);
    }

    const now = new Date().toISOString();
    resource.updatedAt = now;
    this._reconcileCounts(resource);
    return { ...resource };
  }

  reconcileInventory(id) {
    const resource = this.resources.get(id);
    if (!resource) {
      throw new CatalogError(`Resource ${id} not found.`, 'NOT_FOUND', 404);
    }

    this._reconcileCounts(resource);
    const valid = resource.totalCopies === (resource.availableCopies + resource.reservedCopies + resource.checkedOutCopies);
    return {
      resourceId: id,
      valid,
      totalCopies: resource.totalCopies,
      availableCopies: resource.availableCopies,
      reservedCopies: resource.reservedCopies,
      checkedOutCopies: resource.checkedOutCopies,
      status: resource.status,
    };
  }
}

export const defaultCatalog = new CatalogStore();
