/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { Message, MessageType } from "../omnisharp/messageType";
import { BaseChannelObserver } from "./BaseChannelObserver";

export class DotNetChannelObserver extends BaseChannelObserver{   
    public onNext = (message: Message) => {
        switch (message.type) {
            case MessageType.CommandDotNetRestoreStart:
                this.clearChannel();
                this.showChannel();
                break;
        }
    }
}