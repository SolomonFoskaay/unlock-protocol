import Stripe from 'stripe'
import { User } from '../models/user'
import { Charge } from '../models/charge'
import { PaymentIntent } from '../models/paymentIntent'
import { UserReference } from '../models/userReference'
import * as Normalizer from '../utils/normalizer'
import KeyPricer from '../utils/keyPricer'
import { ethereumAddress } from '../types'
import {
  getStripeCustomerIdForAddress,
  saveStripeCustomerIdForAddress,
} from '../operations/stripeOperations'
import logger from '../logger'
import { Op, Sequelize } from 'sequelize'

export class PaymentProcessor {
  stripe: Stripe

  keyPricer: KeyPricer

  constructor(apiKey: string) {
    this.stripe = new Stripe(apiKey, {
      apiVersion: '2020-08-27',
    })
    this.keyPricer = new KeyPricer()
  }

  // eslint-disable-next-line class-methods-use-this
  async findUserByPublicKey(publicKey: ethereumAddress) {
    const normalizedEthereumAddress = Normalizer.ethereumAddress(publicKey)

    return UserReference.findOne({
      where: { publicKey: { [Op.eq]: normalizedEthereumAddress } },
      include: [{ model: User, attributes: ['publicKey'], as: 'User' }],
    })
  }

  /**
   *  appropriate stripe customer id based on the provided token.
   * @param token
   * @param emailAddress
   */
  async updateUserPaymentDetails(
    token: string,
    publicKey: ethereumAddress
  ): Promise<boolean> {
    try {
      const user = await this.findUserByPublicKey(publicKey)
      const stripeCustomerId = await getStripeCustomerIdForAddress(publicKey)

      // If we already have a stripe customer id
      if (stripeCustomerId) {
        await this.stripe.customers.createSource(stripeCustomerId, {
          source: token,
        })

        return true
      }

      const customer = await this.stripe.customers.create({
        email: user ? user.emailAddress : '', // The stripe API does not require a valid email to be passed
        source: token,
      })

      if (!customer) {
        return false
      }

      return !!(await saveStripeCustomerIdForAddress(publicKey, customer.id))
    } catch (error) {
      logger.error(
        `Failed to update payment details for ${publicKey}: there was an error.`,
        error
      )
      return false
    }
  }

  /**
   *  DEPRECATED
   *  Charges an appropriately configured user with purchasing details, with the amount specified
   *  in the purchase details
   * @param userAddress
   * @param purchaseDetails
   */
  async chargeUserForConnectedAccount(
    userAddress: ethereumAddress,
    stripeCustomerId: string,
    lock: ethereumAddress,
    // eslint-disable-next-line no-unused-vars
    connectedStripeId: string,
    network: number,
    maxPrice: number // Agreed to by user!
  ) {
    const pricing = await new KeyPricer().generate(lock, network)
    const totalPriceInCents = Object.values(pricing).reduce((a, b) => a + b)
    const maxPriceInCents = maxPrice * 100
    if (
      Math.abs(totalPriceInCents - maxPriceInCents) >
      0.03 * maxPriceInCents
    ) {
      // if price diverged by more than 3%, we fail!
      throw new Error('Price diverged by more than 3%. Aborting')
    }
    // We need to create a new customer specifically for this stripe connected account

    const token = await this.stripe.tokens.create(
      { customer: stripeCustomerId },
      { stripeAccount: connectedStripeId }
    )

    const connectedCustomer = await this.stripe.customers.create(
      { source: token.id },
      { stripeAccount: connectedStripeId }
    )

    const charge = await this.stripe.charges.create(
      {
        amount: totalPriceInCents,
        currency: 'USD',
        customer: connectedCustomer.id,
        metadata: {
          lock,
          userAddress,
          network,
          maxPrice,
        },
        application_fee_amount: pricing.unlockServiceFee,
      },
      {
        stripeAccount: connectedStripeId,
      }
    )
    return {
      userAddress,
      lock,
      charge: charge.id,
      connectedCustomer: connectedCustomer.id,
      stripeCustomerId,
      totalPriceInCents,
      unlockServiceFee: pricing.unlockServiceFee,
    }
  }

  async createPaymentIntent(
    userAddress: ethereumAddress,
    recipients: ethereumAddress[],
    stripeCustomerId: string, // Stripe token of the buyer
    lock: ethereumAddress,
    maxPrice: any,
    network: number,
    stripeAccount: string,
    recurring = 0
  ) {
    const pricing = await new KeyPricer().generate(
      lock,
      network,
      recipients.length
    )
    const totalPriceInCents = Object.values(pricing).reduce((a, b) => a + b)
    const maxPriceInCents = maxPrice * 100
    if (
      Math.abs(totalPriceInCents - maxPriceInCents) >
      0.03 * maxPriceInCents
    ) {
      // if price diverged by more than 3%, we fail!
      throw new Error('Price diverged by more than 3%. Aborting')
    }

    // Let's see if we have a paymentIntent already that's less than 10 minutes old
    const existingIntent = await PaymentIntent.findOne({
      where: {
        userAddress,
        lockAddress: lock,
        chain: network,
        connectedStripeId: stripeAccount,
        createdAt: {
          [Op.gte]: Sequelize.literal("NOW() - INTERVAL '10 minute'"),
        },
      },
    })

    // We check if there is an intent and use that one
    // if its status is still pending confirmation
    if (
      existingIntent &&
      existingIntent.recipients?.every((recipient) =>
        recipients.includes(recipient)
      )
    ) {
      const stripeIntent = await this.stripe.paymentIntents.retrieve(
        existingIntent.intentId,
        {
          stripeAccount: existingIntent.connectedStripeId,
        }
      )
      if (stripeIntent.status === 'requires_confirmation') {
        return {
          clientSecret: stripeIntent.client_secret,
          stripeAccount,
          pricing,
          totalPriceInCents,
        }
      }
    }

    const globalPaymentMethods = await this.stripe.paymentMethods.list({
      customer: stripeCustomerId,
      type: 'card',
    })

    const primaryMethod = globalPaymentMethods.data[0]

    // Clone payment method
    const method = await this.stripe.paymentMethods.create(
      {
        payment_method: primaryMethod.id,
        customer: stripeCustomerId,
      },
      {
        stripeAccount,
      }
    )

    // Find existing customer with the user address in the metadata
    const customers = await this.stripe.customers.search(
      {
        query: `metadata["userAddress"]:"${userAddress}"`,
      },
      {
        stripeAccount,
      }
    )

    let connectedCustomer = customers.data[0]

    if (!connectedCustomer) {
      // Clone customer if no customer with user address in the metadata exists.
      connectedCustomer = await this.stripe.customers.create(
        {
          payment_method: method.id,
          metadata: {
            userAddress,
          },
        },
        { stripeAccount }
      )
    }

    const intent = await this.stripe.paymentIntents.create(
      {
        amount: totalPriceInCents,
        currency: 'usd',
        customer: connectedCustomer.id,
        payment_method: method.id,
        capture_method: 'manual', // We need to confirm on front-end but will capture payment back on backend.
        metadata: {
          purchaser: userAddress,
          lock,
          recurring,
          // For compaitibility and stripe limitation (cannot store an array), we are using the same recipient field name but storing multiple recipients in case we have them.
          recipient: recipients.join(','),
          network,
          maxPrice,
        },
        application_fee_amount: pricing.unlockServiceFee,
      },
      { stripeAccount }
    )

    // Store the paymentIntent
    // Note: to avoid multiple purchases, we should make sure we don't create a new one if one already exists!
    await PaymentIntent.create({
      userAddress,
      lockAddress: lock,
      chain: network,
      recipients,
      stripeCustomerId: stripeCustomerId, // Unlock "global" Customer Id
      intentId: intent.id,
      connectedStripeId: stripeAccount, // connected account
      connectedCustomerId: connectedCustomer.id, // connected Customer Id
    })

    return {
      clientSecret: intent.client_secret,
      stripeAccount,
      totalPriceInCents,
      pricing,
    }
  }

  async createSetupIntent({ customerId }: { customerId: string }) {
    const setupIntent = await this.stripe.setupIntents.create({
      customer: customerId,
      payment_method_types: ['card', 'link'],
    })
    return {
      clientSecret: setupIntent.client_secret,
    }
  }

  async listCardMethods({ customerId }: { customerId: string }) {
    const methods = await this.stripe.paymentMethods.list({
      customer: customerId,
      type: 'card',
    })
    return methods.data
  }

  async getPaymentIntentRecordAndCharge({
    userAddress,
    lockAddress,
    recipients,
    network,
    paymentIntentId,
  }: {
    userAddress: ethereumAddress
    lockAddress: ethereumAddress
    recipients: ethereumAddress[]
    network: number
    paymentIntentId: string
  }) {
    const pricing = await new KeyPricer().generate(
      lockAddress,
      network,
      recipients.length
    )
    const totalPriceInCents = Object.values(pricing).reduce((a, b) => a + b)

    const paymentIntentRecord = await PaymentIntent.findOne({
      where: { intentId: paymentIntentId },
    })

    if (!paymentIntentRecord) {
      throw new Error('Could not find payment intent.')
    }

    const paymentIntent = await this.stripe.paymentIntents.retrieve(
      paymentIntentId,
      {
        stripeAccount: paymentIntentRecord.connectedStripeId,
      }
    )

    if (paymentIntent.status !== 'requires_capture') {
      throw new Error(
        'Stripe payment could not be captured, please refresh and try again'
      )
    }

    if (paymentIntent.metadata.lock !== lockAddress) {
      throw new Error('Lock does not match with initial intent.')
    }

    if (paymentIntent.metadata.purchaser !== userAddress) {
      throw new Error('User Address does not match with initial intent.')
    }

    if (
      !paymentIntent.metadata.recipient
        .split(',')
        .every((r) => recipients.includes(r))
    ) {
      throw new Error('Recipient does not match with initial intent.')
    }

    const maxPriceInCents = paymentIntent.amount
    if (
      Math.abs(totalPriceInCents - maxPriceInCents) >
      0.03 * maxPriceInCents
    ) {
      // if price diverged by more than 3%, we fail!
      logger.error('Price diverged by more than 3%', {
        totalPriceInCents,
        maxPriceInCents,
      })
      throw new Error('Price diverged by more than 3%.')
    }

    // Create the charge object on our end!
    const charge: Charge = await Charge.create({
      userAddress: paymentIntent.metadata.purchaser,
      recipients: paymentIntent.metadata.recipient.split(','),
      lock: paymentIntent.metadata.lock,
      stripeCustomerId: paymentIntent.customer?.toString(), // TODO: consider checking the customer id under Unlock's stripe account?
      connectedCustomer: paymentIntent.customer?.toString(),
      totalPriceInCents: paymentIntent.amount,
      unlockServiceFee: paymentIntent.application_fee_amount,
      stripeCharge: paymentIntent.id,
      recurring: parseInt(paymentIntent.metadata.recurring),
      chain: network,
    })

    return {
      paymentIntent,
      paymentIntentRecord,
      charge,
    }
  }
}

export default PaymentProcessor
