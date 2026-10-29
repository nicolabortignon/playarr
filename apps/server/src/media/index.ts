import type { Config } from '../config.ts';
import { LocalMediaSource } from './local.ts';
import { SftpMediaSource } from './sftp.ts';
import { NoMediaSource, type MediaSource } from './source.ts';
import { SshConnection, SshExecMediaSource } from './ssh.ts';

export function createMediaSource(config: Config): MediaSource {
  switch (config.MEDIA_SOURCE) {
    case 'local':
      return new LocalMediaSource(config.FFMPEG_PATH);
    case 'sftp':
    case 'ssh': {
      if (!config.SSH_HOST || !config.SSH_USER) {
        throw new Error(`MEDIA_SOURCE=${config.MEDIA_SOURCE} requires SSH_HOST and SSH_USER`);
      }
      const conn = new SshConnection({
        host: config.SSH_HOST,
        port: config.SSH_PORT,
        username: config.SSH_USER,
        privateKeyPath: config.SSH_PRIVATE_KEY_PATH,
        password: config.SSH_PASSWORD,
      });
      return config.MEDIA_SOURCE === 'sftp' ? new SftpMediaSource(conn) : new SshExecMediaSource(conn, config.FFMPEG_PATH);
    }
    case 'none':
      return new NoMediaSource();
  }
}

export { mapPath, MediaUnavailableError, type MediaSource } from './source.ts';
