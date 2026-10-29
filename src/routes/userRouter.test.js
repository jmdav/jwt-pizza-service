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

describe('delete users', () => {
    const adminIds = [];
    let adminToken;

    beforeAll(async () => {
        const admin = await DB.addUser({
            name: `user-router-admin-${randomName()}`,
            email: `${randomName()}@test.com`,
            password: 'admin-test-password',
            roles: [{ role: Role.Admin }],
        });
        adminIds.push(admin.id);
        const login = await request(app).put('/api/auth').send({ email: admin.email, password: 'admin-test-password' });
        expect(login.status).toBe(200);
        adminToken = login.body.token;
    });

    afterAll(async () => {
        await deleteUsers(adminIds);
    });

    test('requires authentication', async () => {
        const response = await request(app).delete(`/api/user/${adminIds[0]}`);
        expect(response.status).toBe(401);
    });

    test('a diner cannot delete a user, including themselves', async () => {
        const [user, token] = await registerUser(request(app), `user-router-denied-${randomName()}`);
        try {
            for (const userId of [user.id, adminIds[0]]) {
                const response = await request(app)
                    .delete(`/api/user/${userId}`)
                    .set('Authorization', `Bearer ${token}`);
                expect(response.status).toBe(403);
            }
            expect((await DB.getUsers(1, 10, user.name)).users).toEqual([
                { id: user.id, name: user.name, email: user.email },
            ]);
            expect(await DB.isLoggedIn(token)).toBe(true);
        } finally {
            await deleteUsers([user.id]);
        }
    });

    test('an admin can delete a user and revoke their sessions and roles', async () => {
        const [user, token] = await registerUser(request(app), `user-router-delete-${randomName()}`);
        try {
            const response = await request(app)
                .delete(`/api/user/${user.id}`)
                .set('Authorization', `Bearer ${adminToken}`);
            expect(response.status).toBe(200);
            expect(response.body).toEqual({ message: 'user deleted' });
            expect((await DB.getUsers(1, 10, user.name)).users).toEqual([]);

            const connection = await DB.getConnection();
            try {
                expect(await DB.query(connection, 'SELECT userId FROM auth WHERE userId=?', [user.id])).toEqual([]);
                expect(await DB.query(connection, 'SELECT userId FROM userRole WHERE userId=?', [user.id])).toEqual([]);
            } finally {
                await connection.end();
            }

            const deletedSession = await request(app).get('/api/user/me').set('Authorization', `Bearer ${token}`);
            expect(deletedSession.status).toBe(401);

            const repeatedDelete = await request(app)
                .delete(`/api/user/${user.id}`)
                .set('Authorization', `Bearer ${adminToken}`);
            expect(repeatedDelete.status).toBe(404);
        } finally {
            await deleteUsers([user.id]);
        }
    });

    test.each(['0', '-1', 'abc', '1.5', '9007199254740992'])('rejects invalid user ID %s', async (userId) => {
        const response = await request(app)
            .delete(`/api/user/${userId}`)
            .set('Authorization', `Bearer ${adminToken}`);
        expect(response.status).toBe(400);
    });
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
