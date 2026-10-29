import { Injectable } from '@nestjs/common';
import { Channel } from '@prisma/client';
import { FacebookAdapter } from './facebook.adapter';
import { SimulatedAdapter } from './simulated.adapter';
import { ChannelAdapter } from './types';
import { ZaloAdapter } from './zalo.adapter';

@Injectable()
export class AdapterRegistry {
  constructor(public facebook: FacebookAdapter, public zalo: ZaloAdapter, public simulated: SimulatedAdapter) {}

  for(channel: Channel): ChannelAdapter {
    if (channel.isSimulated) return this.simulated;
    return channel.type === 'FACEBOOK' ? this.facebook : this.zalo;
  }
}
