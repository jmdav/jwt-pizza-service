const mysql = require('mysql2/promise');
const jwt = require('jsonwebtoken');
const config = require('../config.js');
const { Role, DB } = require('./database.js');

const testUserIds = [];
const testMenuIds = [];
const testFranchiseIds = [];
const testStoreIds = [];
const testOrderIds = [];

function randomName() {
  return Math.random().toString(36).substring(2, 12);
}

async function makeTestUser(role = Role.Admin) {
  const name = randomName();
  const email = `${name}@gmail.com`;
  const password = 'notenoughsecrets';
  const user = await DB.addUser({ name, email, password, roles: [{ role }] });

  testUserIds.push(user.id);
  return { user, password };
}

async function makeTestMenuItem() {
  const item = await DB.addMenuItem({
    title: randomName(),
    description: 'pizza pie',
    image: 'pizza.png',
    price: 10,
  });

  testMenuIds.push(item.id);
  return item;
}

async function makeTestFranchise(adminEmail, name = randomName()) {
  const franchise = await DB.createFranchise({
    name,
    admins: [{ email: adminEmail }],
  });

  testFranchiseIds.push(franchise.id);
  return franchise;
}

beforeAll(async () => {
  await DB.initialized;
});

afterAll(async () => {
  const connection = await mysql.createConnection(config.db.connection);

  try {
    await connection.query(`USE ${config.db.connection.database}`);

    for (const orderId of testOrderIds) {
      await connection.execute('DELETE FROM orderItem WHERE orderId=?', [orderId]);
      await connection.execute('DELETE FROM dinerOrder WHERE id=?', [orderId]);
    }

    for (const storeId of testStoreIds) {
      await connection.execute('DELETE FROM store WHERE id=?', [storeId]);
    }

    for (const franchiseId of testFranchiseIds) {
      await connection.execute('DELETE FROM userRole WHERE objectId=?', [franchiseId]);
      await connection.execute('DELETE FROM franchise WHERE id=?', [franchiseId]);
    }

    for (const menuId of testMenuIds) {
      await connection.execute('DELETE FROM menu WHERE id=?', [menuId]);
    }

    for (const userId of testUserIds) {
      await connection.execute('DELETE FROM auth WHERE userId=?', [userId]);
      await connection.execute('DELETE FROM userRole WHERE userId=?', [userId]);
      await connection.execute('DELETE FROM user WHERE id=?', [userId]);
    }
  } finally {
    await connection.end();
  }
});

test('database helpers return expected values', () => {
  expect(DB.getOffset()).toBe(0);
  expect(DB.getOffset(3, 10)).toBe(20);
  expect(DB.getTokenSignature('header.payload.signature')).toBe('signature');
  expect(DB.getTokenSignature('not-a-jwt')).toBe('');
});

test('menu can be retrieved', async () => {
  const menu = await DB.getMenu();

  expect(menu).toEqual(expect.any(Array));
});

test('menu items can be added and retrieved', async () => {
  const testItem = await makeTestMenuItem();
  const menu = await DB.getMenu();

  expect(menu).toEqual(expect.arrayContaining([expect.objectContaining(testItem)]));
});

test('users can be added and retrieved', async () => {
  const { user, password } = await makeTestUser();
  const retrievedUser = await DB.getUser(user.email, password);

  expect(retrievedUser).toMatchObject({
    id: user.id,
    name: user.name,
    email: user.email,
    roles: [{ role: Role.Admin }],
  });
  expect(retrievedUser.password).toBeUndefined();
  await expect(DB.getUser(user.email, 'wrong-password')).rejects.toMatchObject({ statusCode: 404 });
});

test('users can be updated', async () => {
  const { user, password } = await makeTestUser();
  const newUserName = randomName();
  const newUserEmail = `${newUserName}@gmail.com`;
  const updatedUser = await DB.updateUser(user.id, newUserName, newUserEmail, password);

  expect(updatedUser).toMatchObject({
    id: user.id,
    name: newUserName,
    email: newUserEmail,
    roles: [{ role: Role.Admin }],
  });
});

test('users can be logged in and logged out', async () => {
  const { user, password } = await makeTestUser();
  const retrievedUser = await DB.getUser(user.email, password);
  const token = jwt.sign(retrievedUser, config.jwtSecret);

  await DB.loginUser(retrievedUser.id, token);
  expect(await DB.isLoggedIn(token)).toBe(true);

  await DB.logoutUser(token);
  expect(await DB.isLoggedIn(token)).toBe(false);
});

test('orders can be added and retrieved with their items', async () => {
  const { user } = await makeTestUser(Role.Diner);
  const menuItem = await makeTestMenuItem();
  const franchise = await makeTestFranchise(user.email);
  const store = await DB.createStore(franchise.id, { name: randomName() });
  testStoreIds.push(store.id);

  const order = await DB.addDinerOrder(user, {
    franchiseId: franchise.id,
    storeId: store.id,
    items: [{ menuId: menuItem.id, description: 'test order item', price: 10 }],
  });
  testOrderIds.push(order.id);

  expect(order).toMatchObject({
    id: expect.any(Number),
    franchiseId: franchise.id,
    storeId: store.id,
  });

  const orders = await DB.getOrders(user, 1);
  expect(orders).toMatchObject({ dinerId: user.id, page: 1 });
  expect(orders.orders).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: order.id,
        items: [expect.objectContaining({ menuId: menuItem.id, description: 'test order item', price: 10 })],
      }),
    ])
  );
});

test('franchises can be listed for admins and other users', async () => {
  const { user } = await makeTestUser();
  const franchiseName = randomName();
  const franchise = await makeTestFranchise(user.email, `${franchiseName}-one`);
  const secondFranchise = await makeTestFranchise(user.email, `${franchiseName}-two`);
  const store = await DB.createStore(franchise.id, { name: randomName() });
  testStoreIds.push(store.id);

  const [adminFranchises, adminMore] = await DB.getFranchises(
    { isRole: (role) => role === Role.Admin },
    0,
    10,
    `${franchiseName}*`
  );
  expect(adminMore).toBe(false);
  expect(adminFranchises).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: franchise.id,
        admins: expect.arrayContaining([expect.objectContaining({ email: user.email })]),
        stores: expect.arrayContaining([expect.objectContaining({ id: store.id, name: store.name })]),
      }),
    ])
  );

  const [franchises, more] = await DB.getFranchises(null, 0, 1, `${franchiseName}*`);
  expect(more).toBe(true);
  expect(franchises).toHaveLength(1);
  expect(franchises[0].stores).toEqual(expect.arrayContaining([expect.objectContaining({ id: store.id })]));

  const userFranchises = await DB.getUserFranchises(user.id);
  expect(userFranchises).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: franchise.id, admins: expect.any(Array), stores: expect.any(Array) }),
      expect.objectContaining({ id: secondFranchise.id, admins: expect.any(Array), stores: expect.any(Array) }),
    ])
  );
});

test('franchise creation rejects unknown administrators', async () => {
  await expect(
    DB.createFranchise({
      name: randomName(),
      admins: [{ email: `${randomName()}@unknown.com` }],
    })
  ).rejects.toMatchObject({ statusCode: 404 });
});

test('stores and franchises can be deleted', async () => {
  const { user } = await makeTestUser();
  const franchise = await makeTestFranchise(user.email);
  const store = await DB.createStore(franchise.id, { name: randomName() });
  testStoreIds.push(store.id);

  await DB.deleteStore(franchise.id, store.id);
  const updatedFranchise = await DB.getFranchise({ id: franchise.id });
  expect(updatedFranchise.stores).toEqual([]);

  await DB.deleteFranchise(franchise.id);
  const [remaining] = await DB.getFranchises(null, 0, 10, `${franchise.name}*`);
  expect(remaining).toEqual([]);
});

test('getID rejects when a record does not exist', async () => {
  const connection = await DB._getConnection();

  try {
    await expect(DB.getID(connection, 'id', -1, 'menu')).rejects.toThrow('No ID found');
  } finally {
    await connection.end();
  }
});
