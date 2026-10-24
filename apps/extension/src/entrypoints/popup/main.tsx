/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The popup's entry: one port to the worker, one render.

import { mountPage } from '../../ui/page';
import { Popup } from '../../ui/popup/Popup';
import { connectUi } from '../../ui/store';

mountPage('popup.document_title', <Popup ui={connectUi()} />);
