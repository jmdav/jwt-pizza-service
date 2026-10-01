const mysql = require('mysql2/promise');
const request = require('supertest');
const app = require('../service');
const config = require('../config.js');
const { DB, Role } = require('../database/database.js');

const testName = `franchise-router-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
const password = 'franchise-router-password';
const userIds = [];
const franchiseIds = [];
const storeIds = [];

let admin;
let adminToken;

beforeAll(async () => {
  await DB.initialized;

  admin = await DB.addUser({
    name: `${testName}-admin`,
    email: `${testName}-admin@test.com`,
    password,
    roles: [{ role: Role.Admin }],
  });
  userIds.push(admin.id);

  const login = await request(app).put('/api/auth').send({ email: admin.email, password });
  expect(login.status).toBe(200);
  adminToken = login.body.token;
});

afterAll(async () => {
  const connection = await mysql.createConnection(config.db.connection);

  try {
    await connection.query(`USE ${config.db.connection.database}`);

    for (const storeId of storeIds) {
      await connection.execute('DELETE FROM store WHERE id=?', [storeId]);
    }
    for (const franchiseId of franchiseIds) {
      await connection.execute('DELETE FROM userRole WHERE objectId=?', [franchiseId]);
      await connection.execute('DELETE FROM franchise WHERE id=?', [franchiseId]);
    }
    for (const userId of userIds) {
      await connection.execute('DELETE FROM auth WHERE userId=?', [userId]);
      await connection.execute('DELETE FROM userRole WHERE userId=?', [userId]);
      await connection.execute('DELETE FROM user WHERE id=?', [userId]);
    }
  } finally {
    await connection.end();
  }
});

test('an admin can create and manage a franchise and store', async () => {
  const franchiseName = `${testName}-franchise`;
  const createFranchise = await request(app)
    .post('/api/franchise')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ name: franchiseName, admins: [{ email: admin.email }] });

  expect(createFranchise.status).toBe(200);
  expect(createFranchise.body).toMatchObject({ name: franchiseName, id: expect.any(Number) });
  franchiseIds.push(createFranchise.body.id);

  const franchises = await request(app).get('/api/franchise').query({ name: `${franchiseName}*` });
  expect(franchises.status).toBe(200);
  expect(franchises.body.franchises).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: createFranchise.body.id, name: franchiseName })])
  );

  const createStore = await request(app)
    .post(`/api/franchise/${createFranchise.body.id}/store`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ name: `${testName}-store` });

  expect(createStore.status).toBe(200);
  expect(createStore.body).toMatchObject({
    id: expect.any(Number),
    franchiseId: createFranchise.body.id,
    name: `${testName}-store`,
  });
  storeIds.push(createStore.body.id);

  const userFranchises = await request(app)
    .get(`/api/franchise/${admin.id}`)
    .set('Authorization', `Bearer ${adminToken}`);
  expect(userFranchises.status).toBe(200);
  expect(userFranchises.body).toEqual(expect.arrayContaining([expect.objectContaining({ id: createFranchise.body.id })]));

  const deleteStore = await request(app)
    .delete(`/api/franchise/${createFranchise.body.id}/store/${createStore.body.id}`)
    .set('Authorization', `Bearer ${adminToken}`);
  expect(deleteStore.status).toBe(200);
  expect(deleteStore.body).toEqual({ message: 'store deleted' });

  const deleteFranchise = await request(app)
    .delete(`/api/franchise/${createFranchise.body.id}`)
    .set('Authorization', `Bearer ${adminToken}`);
  expect(deleteFranchise.status).toBe(200);
  expect(deleteFranchise.body).toEqual({ message: 'franchise deleted' });
});

test('franchise management requires authentication', async () => {
  const response = await request(app).post('/api/franchise').send({ name: `${testName}-unauthorized`, admins: [] });

  expect(response.status).toBe(401);
  expect(response.body).toEqual({ message: 'unauthorized' });
});
