const request = require('supertest');
const app = require('../service');
const { DB, Role } = require('../database/database.js');

test('list users unauthorized', async () => {
    const listUsersRes = await request(app).get('/api/user');
    expect(listUsersRes.status).toBe(401);
});

test('list users filtered by name includes the matching user', async () => {
    const testName = `user-router-${randomName()}`;
    const [user, userToken] = await registerUser(request(app), testName);

    try {
        const listUsersRes = await request(app)
            .get('/api/user')
            .query({ page: 1, limit: 10, name: testName })
            .set('Authorization', 'Bearer ' + userToken);

        expect(listUsersRes.status).toBe(200);
        expect(listUsersRes.body.users).toEqual([{ id: user.id, name: testName, email: user.email }]);
        expect(listUsersRes.body.more).toBe(false);
    } finally {
        await deleteUsers([user.id]);
    }
});

test('list users paginates by page and limit', async () => {
    const testName = `user-router-page-${randomName()}`;
    const users = [];
    let userToken;

    try {
        const [firstUser, token] = await registerUser(request(app), `${testName}-00`);
        users.push(firstUser);
        userToken = token;

        for (let index = 1; index < 12; index++) {
            const suffix = String(index).padStart(2, '0');
            users.push(await DB.addUser({
                name: `${testName}-${suffix}`,
                email: `${testName}-${suffix}@test.com`,
                password: 'a',
                roles: [{ role: Role.Diner }],
            }));
        }

        const pageTwoRes = await request(app)
            .get('/api/user')
            .query({ page: 2, limit: 5, name: `${testName}*` })
            .set('Authorization', 'Bearer ' + userToken);
        expect(pageTwoRes.status).toBe(200);
        expect(pageTwoRes.body.users).toEqual(users.slice(5, 10).map(({ id, name, email }) => ({ id, name, email })));
        expect(pageTwoRes.body.more).toBe(true);

        const pageThreeRes = await request(app)
            .get('/api/user')
            .query({ page: 3, limit: 5, name: `${testName}*` })
            .set('Authorization', 'Bearer ' + userToken);
        expect(pageThreeRes.status).toBe(200);
        expect(pageThreeRes.body.users).toEqual(users.slice(10).map(({ id, name, email }) => ({ id, name, email })));
        expect(pageThreeRes.body.more).toBe(false);
    } finally {
        await deleteUsers(users.map(({ id }) => id));
    }
});

async function registerUser(service, name = 'pizza diner') {
    const testUser = {
        name,
        email: `${randomName()}@test.com`,
        password: 'a',
    };
    const registerRes = await service.post('/api/auth').send(testUser);
    registerRes.body.user.password = testUser.password;

    return [registerRes.body.user, registerRes.body.token];
}

function randomName() {
    return Math.random().toString(36).substring(2, 12);
}

async function deleteUsers(userIds) {
    if (userIds.length === 0) return;

    const connection = await DB.getConnection();
    const placeholders = userIds.map(() => '?').join(',');
    try {
        await DB.query(connection, `DELETE FROM auth WHERE userId IN (${placeholders})`, userIds);
        await DB.query(connection, `DELETE FROM userRole WHERE userId IN (${placeholders})`, userIds);
        await DB.query(connection, `DELETE FROM user WHERE id IN (${placeholders})`, userIds);
    } finally {
        await connection.end();
    }
}
