const express = require('express');
const path = require('path');
const fs = require('fs');
const stream = require('stream');
const { promisify } = require('util');
const pipeline = promisify(stream.pipeline);
const app = express();
const port = 4242;
const cluster = require('cluster');
const numWorkers = Math.max(2, require('os').cpus().length); 
const zlib = require('zlib');

if (cluster.isMaster) {
    console.log(Master process ${ process.pid } is running);

    for (let i = 0; i < numWorkers; i++) {
        cluster.fork();
    }

    cluster.on('exit', (worker, code, signal) => {
        console.log(Worker ${ worker.process.pid } died.Restarting...);
        cluster.fork();
    });

    //log active connections
    let totalConnections = 0;
    setInterval(() => {
        console.log(Active connections: ${ totalConnections });
    }, 10000);

    Object.values(cluster.workers).forEach(worker => {
        worker.on('message', (msg) => {
            if (msg.cmd === 'CONNECTION_COUNT') {
                totalConnections = msg.count;
            }
        });
    });
} else {

    //base directory for DLC files with absolute paths
    const baseDirectory = path.resolve(process.env.DLC_DIRECTORY || 'dlc');
    const altDirectory = path.resolve(path.join(baseDirectory, 'dlc'));

    if (!fs.existsSync(baseDirectory)) {
        fs.mkdirSync(baseDirectory, { recursive: true });
        console.log(Created DLC directory: ${ baseDirectory });
    }

    if (!fs.existsSync(altDirectory)) {
        fs.mkdirSync(altDirectory, { recursive: true });
        console.log(Created alternate DLC directory: ${ altDirectory });
    }

    app.set('etag', 'strong');
    app.set('x-powered-by', false); 

    //increase Node.js performance settings thanks gbt
    process.setMaxListeners(0);

    //track active connections
    let activeConnections = 0;

    app.use((req, res, next) => {
        activeConnections++;
        process.send({ cmd: 'CONNECTION_COUNT', count: activeConnections });

        res.on('finish', () => {
            activeConnections--;
            process.send({ cmd: 'CONNECTION_COUNT', count: activeConnections });
        });

        res.on('close', () => {
            activeConnections--;
            process.send({ cmd: 'CONNECTION_COUNT', count: activeConnections });
        });

        next();
    });


    const highWaterMark = 1024 * 1024 * 4; // 4MB chunks - good balance for concurrency

    //logging middleware - only log sick of headachee reading logs
    app.use((req, res, next) => {
        const start = Date.now();
        res.on('finish', () => {
            const duration = Date.now() - start;
            if (res.statusCode >= 400 || duration > 1000) {
                console.log(${ new Date().toISOString() } - ${ req.method } ${ req.url } - ${ res.statusCode } - ${ duration }ms - ${ req.ip });
            }
        });
        next();
    });

    app.use('/static', (req, res, next) => {
        let relativePath = req.path;
        while (relativePath.includes('//')) {
            relativePath = relativePath.replace('//', '/');
        }

        if (relativePath === '/' || relativePath === '') {
            relativePath = '/dlc/DLCIndex.zip';
        }

        if (relativePath.startsWith('/')) {
            relativePath = relativePath.substring(1);
        }

        const primaryPath = path.resolve(path.join(baseDirectory, relativePath));
        const altPath = path.resolve(path.join(altDirectory, relativePath));

        if (!primaryPath.startsWith(baseDirectory) && !primaryPath.startsWith(altDirectory)) {
            return res.status(403).send('Access denied');
        }

        const streamFile = async (filePath) => {
            try {
                const stat = await fs.promises.stat(filePath);

                const isLargeFile = stat.size > 1024 * 1024 * 100; // 100MB+

                const acceptsGzip = !isLargeFile &&
                    req.headers['accept-encoding'] &&
                    req.headers['accept-encoding'].includes('gzip') &&
                    isCompressibleFile(filePath) &&
                    stat.size > 1024; 

                const range = req.headers.range;
                if (range) {
                    const parts = range.replace(/bytes=/, '').split('-');
                    const start = parseInt(parts[0], 10);
                    const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
                    const chunkSize = (end - start) + 1;

                    if (start >= stat.size || end >= stat.size || start < 0 || end < 0) {
                        res.status(416).send('Range Not Satisfiable');
                        return true;
                    }

                    res.writeHead(206, {
                        'Content-Range': bytes ${ start } - ${ end } / ${ stat.size },
                        'Accept-Ranges': 'bytes',
                        'Content-Length': chunkSize,
                        'Content-Type': getContentType(filePath),
                        'Cache-Control': 'public, max-age=3600',
                        'Last-Modified': stat.mtime.toUTCString(),
          });


    const streamOptions = {
        start,
        end,
        highWaterMark: isLargeFile ? highWaterMark / 2 : highWaterMark 
    };

    const fileStream = fs.createReadStream(filePath, streamOptions);

    fileStream.on('error', (error) => {
        console.error(Error streaming file: ${ error.message });
        if (!res.headersSent) {
            res.status(500).send('Error streaming file');
        }
    });

    await pipeline(fileStream, res);
} else {
    const headers = {
        'Content-Length': stat.size,
        'Content-Type': getContentType(filePath),
        'Cache-Control': 'public, max-age=3600',
        'Last-Modified': stat.mtime.toUTCString(),
        'Accept-Ranges': 'bytes'
    };

    if (acceptsGzip) {
        headers['Content-Encoding'] = 'gzip';
        delete headers['Content-Length'];
    }

    res.writeHead(200, headers);

    const streamOptions = {
        highWaterMark: isLargeFile ? highWaterMark / 2 : highWaterMark 
    };

    const fileStream = fs.createReadStream(filePath, streamOptions);

    fileStream.on('error', (error) => {
        console.error(Error streaming file: ${ error.message });
        if (!res.headersSent) {
            res.status(500).send('Error streaming file');
        }
    });

    if (acceptsGzip) {
        const gzip = zlib.createGzip({
            level: 4,  
            flush: zlib.Z_SYNC_FLUSH,
            chunkSize: highWaterMark / 2
        });

        await pipeline(fileStream, gzip, res);
    } else {
        await pipeline(fileStream, res);
    }
}
return true;
      } catch (error) {
    if (error.code === 'ENOENT') {
        return false; // File not found
    }
    console.error(Error serving file ${ filePath }: ${ error.message });
    if (!res.headersSent) {
        res.status(500).send('Server error');
    }
    return true; 
}
    };

(async () => {
    try {
        if (await fs.promises.access(primaryPath).then(() => true).catch(() => false)) {
            const stat = await fs.promises.stat(primaryPath);
            if (stat.isFile()) {
                await streamFile(primaryPath);
                return;
            }
        }

        if (await fs.promises.access(altPath).then(() => true).catch(() => false)) {
            const stat = await fs.promises.stat(altPath);
            if (stat.isFile()) {
                await streamFile(altPath);
                return;
            }
        }

        res.status(404).send('File not found');
    } catch (error) {
        console.error(Unexpected error: ${ error.message });
        if (!res.headersSent) {
            res.status(500).send('Server error');
        }
    }
})();
  });

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

app.get('/status', (req, res) => {
    res.json({
        status: 'success',
        message: 'Server is running on port ' + port,
        worker: process.pid,
        activeConnections: activeConnections
    });
});

app.use('/webpanel', express.static(path.resolve('webpanel'), {
    maxAge: '1h',
    index: 'index.html',
    etag: true
}));

app.use((req, res) => {
    res.status(404).json({
        status: 'error',
        message: 'Unknown endpoint'
    });
});

app.use((err, req, res, next) => {
    console.error(Error handling request: ${ err.message });
    if (!res.headersSent) {
        res.status(500).json({
            status: 'error',
            message: 'Internal Server Error'
        });
    }
});

const server = app.listen(port, () => {
    console.log(Worker ${ process.pid } - File server running at http://localhost:${port});
  });

server.maxConnections = 1000;

server.timeout = 30 * 60 * 1000; // 30 minutes
}
