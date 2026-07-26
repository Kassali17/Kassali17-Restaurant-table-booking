const serverless = require('serverless-http');
const app = require('../../server');

const expressHandler = serverless(app);

exports.handler = async (event, context) => {
    // Netlify rewrites /api/* to this function. Restore the original Express
    // route before passing the request to the existing application.
    const functionPath = '/.netlify/functions/api';
    if (event.path.startsWith(functionPath)) {
        event.path = '/api' + event.path.slice(functionPath.length);
    }

    return expressHandler(event, context);
};
