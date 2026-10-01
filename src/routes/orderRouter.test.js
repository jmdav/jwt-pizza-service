const mysql = require('mysql2/promise');
const request = require('supertest');
const app = require('../service');
const config = require('../config.js');
const { DB, Role } = require('../database/database.js');

const testName = `order-router-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
const adminPassword = 'order-router-admin-password';
const dinerPassword = 'order-router-diner-password';
const userIds = [];
const menuIds = [];
const franchiseIds = [];
const storeIds = [];
const orderIds = [];

let admin;
let adminToken;
let diner;
let dinerToken;
let franchise;
let store;
let menuItem;
const originalFetch = global.fetch;

beforeAll(async () => {
  await DB.initialized;

  admin = await DB.addUser({
    name: `${testName}-admin`,
    email: `${testName}-admin@test.com`,
    password: adminPassword,
    roles: [{ role: Role.Admin }],
  });
  diner = await DB.addUser({
    name: `${testName}-diner`,
    email: `${testName}-diner@test.com`,
    password: dinerPassword,
    roles: [{ role: Role.Diner }],
  });
  userIds.push(admin.id, diner.id);

  const adminLogin = await request(app).put('/api/auth').send({ email: admin.email, password: adminPassword });
  const dinerLogin = await request(app).put('/api/auth').send({ email: diner.email, password: dinerPassword });
  expect(adminLogin.status).toBe(200);
  expect(dinerLogin.status).toBe(200);
  adminToken = adminLogin.body.token;
  dinerToken = dinerLogin.body.token;

  menuItem = await DB.addMenuItem({
    title: `${testName}-pizza`,
    description: 'order router test pizza',
    image: 'order-router-test.png',
    price: 12.34,
  });
  menuIds.push(menuItem.id);

  franchise = await DB.createFranchise({
    name: `${testName}-franchise`,
    admins: [{ email: admin.email }],
  });
  franchiseIds.push(franchise.id);
  store = await DB.createStore(franchise.id, { name: `${testName}-store` });
  storeIds.push(store.id);
});

afterAll(async () => {
  global.fetch = originalFetch;

  const connection = await mysql.createConnection(config.db.connection);
  try {
    await connection.query(`USE ${config.db.connection.database}`);

    for (const orderId of orderIds) {
      await connection.execute('DELETE FROM orderItem WHERE orderId=?', [orderId]);
      await connection.execute('DELETE FROM dinerOrder WHERE id=?', [orderId]);
    }
    for (const storeId of storeIds) {
      await connection.execute('DELETE FROM store WHERE id=?', [storeId]);
    }
    for (const franchiseId of franchiseIds) {
      await connection.execute('DELETE FROM userRole WHERE objectId=?', [franchiseId]);
      await connection.execute('DELETE FROM franchise WHERE id=?', [franchiseId]);
    }
    for (const menuId of menuIds) {
      await connection.execute('DELETE FROM menu WHERE id=?', [menuId]);
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

test('anyone can retrieve the menu', async () => {
  const response = await request(app).get('/api/order/menu');

  expect(response.status).toBe(200);
  expect(response.body).toEqual(expect.arrayContaining([expect.objectContaining(menuItem)]));
});

test('an admin can add a menu item', async () => {
  const title = `${testName}-admin-pizza`;
  const response = await request(app)
    .put('/api/order/menu')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ title, description: 'admin test pizza', image: 'admin-test.png', price: 8.5 });

  expect(response.status).toBe(200);
  const addedItem = response.body.find((item) => item.title === title);
  expect(addedItem).toMatchObject({ title, description: 'admin test pizza', image: 'admin-test.png', price: 8.5 });
  menuIds.push(addedItem.id);
});

test('a diner can retrieve their orders', async () => {
  const response = await request(app).get('/api/order').set('Authorization', `Bearer ${dinerToken}`);

  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({ dinerId: diner.id, page: 1, orders: expect.any(Array) });
});

test('a diner can create an order and send it to the factory', async () => {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ reportUrl: 'https://factory.test/report', jwt: 'factory-test-jwt' }),
  });

  const response = await request(app)
    .post('/api/order')
    .set('Authorization', `Bearer ${dinerToken}`)
    .send({
      franchiseId: franchise.id,
      storeId: store.id,
      items: [{ menuId: menuItem.id, description: 'order router test pizza', price: 12.34 }],
    });

  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({
    order: { id: expect.any(Number), franchiseId: franchise.id, storeId: store.id },
    followLinkToEndChaos: 'https://factory.test/report',
    jwt: 'factory-test-jwt',
  });
  orderIds.push(response.body.order.id);
  expect(global.fetch).toHaveBeenCalledWith(
    `${config.factory.url}/api/order`,
    expect.objectContaining({ method: 'POST', body: expect.stringContaining(`"id":${diner.id}`) })
  );
});

test('orders require authentication', async () => {
  const response = await request(app).get('/api/order');

  expect(response.status).toBe(401);
  expect(response.body).toEqual({ message: 'unauthorized' });
});
