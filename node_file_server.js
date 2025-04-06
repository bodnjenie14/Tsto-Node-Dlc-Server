const express = require('express');
const path = require('path');
const fs = require('fs');
const stream = require('stream');
const { promisify } = require('util');
const pipeline = promisify(stream.pipeline);
const app = express();
const port = 4243;
const cluster = require('cluster');
const numWorkers = require('os').cpus().length;
const zlib = require('zlib');

if (cluster.isMaster) {
    console.log(`Master process ${process.pid} is running`);

    // Fork workers
    for (let i = 0; i < numWorkers; i++) {
        cluster.fork();
    }

    // Handle worker crashes
    cluster.on('exit', (worker, code, signal) => {
        console.log(`Worker ${worker.process.pid} died. Restarting...`);
        cluster.fork();
    });
} else {
    // Worker process

    // Set up directories
    const baseDirectory = path.resolve(process.env.DLC_DIRECTORY || 'dlc');
    
    if (!fs.existsSync(baseDirectory)) {
        fs.mkdirSync(baseDirectory, { recursive: true });
        console.log(`Created directory: ${baseDirectory}`);
    }

    // Basic server settings
    app.set('etag', 'strong');
    app.set('x-powered-by', false);

    // Simple request logging
    app.use((req, res, next) => {
        const start = Date.now();
        res.on('finish', () => {
            const duration = Date.now() - start;
            console.log(`${req.method} ${req.url} - ${res.statusCode} - ${duration}ms`);
        });
        next();
    });

    // Main file serving route
    app.use('/static', (req, res, next) => {
        let relativePath = req.path;
        
        // Clean up path
        while (relativePath.includes('//')) {
            relativePath = relativePath.replace('//', '/');
        }

        if (relativePath === '/' || relativePath === '') {
            relativePath = '/dlc/DLCIndex.zip';
        }

        if (relativePath.startsWith('/')) {
            relativePath = relativePath.substring(1);
        }

        const filePath = path.resolve(path.join(baseDirectory, relativePath));

        // Security check
        if (!filePath.startsWith(baseDirectory)) {
            return res.status(403).send('Access denied');
        }

        // Serve the file
        fs.stat(filePath, (err, stat) => {
            if (err) {
                if (err.code === 'ENOENT') {
                    return res.status(404).send('File not found');
                }
                console.error(`Error accessing file ${filePath}:`, err);
                return res.status(500).send('Server error');
            }

            if (!stat.isFile()) {
                return res.status(404).send('Not a file');
            }

            // Handle range requests for partial content
            const range = req.headers.range;
            if (range) {
                const parts = range.replace(/bytes=/, '').split('-');
                const start = parseInt(parts[0], 10);
                const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
                
                if (start >= stat.size || end >= stat.size) {
                    return res.status(416).send('Range Not Satisfiable');
                }

                res.status(206);
                res.set({
                    'Content-Range': `bytes ${start}-${end}/${stat.size}`,
                    'Accept-Ranges': 'bytes',
                    'Content-Length': (end - start) + 1,
                    'Content-Type': getContentType(filePath)
                });

                const stream = fs.createReadStream(filePath, { start, end });
                stream.pipe(res);
                return;
            }

            // Determine if we should compress
            const acceptsGzip = req.headers['accept-encoding'] && 
                               req.headers['accept-encoding'].includes('gzip') && 
                               isCompressibleFile(filePath) &&
                               stat.size > 1024 && 
                               stat.size < 10 * 1024 * 1024; // Only compress files smaller than 10MB

            // Set headers
            res.set({
                'Content-Type': getContentType(filePath),
                'Cache-Control': 'public, max-age=3600',
                'Accept-Ranges': 'bytes'
            });

            if (acceptsGzip) {
                res.set('Content-Encoding', 'gzip');
                const fileStream = fs.createReadStream(filePath);
                const gzip = zlib.createGzip();
                fileStream.pipe(gzip).pipe(res);
            } else {
                res.set('Content-Length', stat.size);
                const fileStream = fs.createReadStream(filePath);
                fileStream.pipe(res);
            }
        });
    });

    // Status endpoint
    app.get('/status', (req, res) => {
        res.json({
            status: 'success',
            message: 'Server is running',
            worker: process.pid,
            uptime: process.uptime()
        });
    });

    // Catch-all for unknown routes
    app.use((req, res) => {
        res.status(404).send('Unknown endpoint');
    });

    // Error handler
    app.use((err, req, res, next) => {
        console.error(`Error: ${err.message}`);
        res.status(500).send('Internal Server Error');
    });

    // Helper functions
    function getContentType(filePath) {
        const ext = path.extname(filePath).toLowerCase();
        const types = {
            '.html': 'text/html',
            '.htm': 'text/html',
            '.css': 'text/css',
            '.js': 'application/javascript',
            '.json': 'application/json',
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.gif': 'image/gif',
            '.svg': 'image/svg+xml',
            '.pdf': 'application/pdf',
            '.zip': 'application/zip',
            '.txt': 'text/plain',
            '.xml': 'application/xml'
        };
        return types[ext] || 'application/octet-stream';
    }

    function isCompressibleFile(filePath) {
        const ext = path.extname(filePath).toLowerCase();
        const compressibleExts = [
            '.html', '.htm', '.css', '.js', '.json', '.txt', '.xml', '.svg'
        ];
        return compressibleExts.includes(ext);
    }

    // Start the server
    const server = app.listen(port, () => {
        console.log(`File server running on port ${port}`);
        
        // Set reasonable timeouts
        server.timeout = 600000; // 10 minutes
        server.keepAliveTimeout = 60000; // 1 minute
    });

    // Handle server errors
    server.on('error', (error) => {
        console.error(`Server error: ${error.message}`);
        if (error.code === 'EADDRINUSE') {
            console.error(`Port ${port} is already in use`);
        }
    });
    
    // Graceful shutdown
    process.on('SIGTERM', () => {
        console.log(`Worker ${process.pid} shutting down`);
        server.close(() => {
            console.log(`Worker ${process.pid} closed`);
            process.exit(0);
        });
        
        setTimeout(() => {
            console.error(`Worker ${process.pid} forced exit`);
            process.exit(1);
        }, 30000);
    });
}
